use anyhow::{anyhow, bail, Context, Result};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel as TauriChannel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ipc::dto::{RemoteEntry, SftpOpResult, SftpTextFile, TransferEvent};
use crate::session::model::Profile;
use crate::transport::ssh::{connect_profile, ConnectedSsh};
use crate::vault::Vault;

const CHUNK: usize = 32 * 1024;
const PART_SUFFIX: &str = ".fanssh-part";
const TEMP_SUFFIX: &str = ".fanssh-tmp";
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

pub struct SftpEntry {
    sftp: SftpSession,
    _conn: ConnectedSsh,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

impl ConflictPolicy {
    fn parse(value: &str) -> Self {
        match value {
            "skip" => Self::Skip,
            "rename" => Self::Rename,
            _ => Self::Overwrite,
        }
    }
}

#[derive(Clone, Default)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<Uuid, Arc<Mutex<SftpEntry>>>>>,
}

impl SftpManager {
    pub async fn open(&self, profile: &Profile, vault: &Vault) -> Result<(Uuid, String)> {
        let conn = connect_profile(profile, vault, None).await?;
        let channel = conn
            .handle
            .channel_open_session()
            .await
            .context("打开 SFTP 通道失败")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("请求 SFTP 子系统失败")?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("SFTP 子系统初始化失败")?;
        let home = sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| "/".to_string());
        let id = Uuid::new_v4();
        self.sessions.lock().await.insert(
            id,
            Arc::new(Mutex::new(SftpEntry {
                sftp,
                _conn: conn,
            })),
        );
        Ok((id, home))
    }

    pub async fn list(&self, id: Uuid, path: &str) -> Result<Vec<RemoteEntry>> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let dir = if path.trim().is_empty() {
            ".".to_string()
        } else {
            path.to_string()
        };
        let read_dir = guard
            .sftp
            .read_dir(dir.clone())
            .await
            .context("读取远程目录失败")?;
        let mut entries = Vec::new();
        for item in read_dir {
            let metadata = item.metadata();
            let name = item.file_name();
            entries.push(RemoteEntry {
                path: join_remote(&dir, &name),
                name,
                is_dir: metadata.is_dir(),
                is_symlink: metadata.is_symlink(),
                size: metadata.size.unwrap_or(0),
                mode: metadata.permissions,
                mtime: metadata.mtime,
            });
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn chmod(&self, id: Uuid, path: &str, mode: u32) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let attributes = FileAttributes {
            permissions: Some(mode & 0o7777),
            ..Default::default()
        };
        guard
            .sftp
            .set_metadata(path.to_string(), attributes)
            .await
            .context("修改权限失败")?;
        Ok(())
    }

    pub async fn upload(
        &self,
        id: Uuid,
        local_paths: Vec<String>,
        remote_dir: String,
        conflict: String,
        restart: bool,
        on_event: TauriChannel<TransferEvent>,
    ) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let policy = ConflictPolicy::parse(&conflict);

        for local in local_paths {
            let local_path = PathBuf::from(&local);
            let name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload.bin".to_string());
            let mut remote_path = join_remote(&remote_dir, &name);

            if guard
                .sftp
                .try_exists(remote_path.clone())
                .await
                .unwrap_or(false)
            {
                match policy {
                    ConflictPolicy::Skip => {
                        let _ = on_event.send(TransferEvent::Skipped {
                            id: Uuid::new_v4(),
                            name,
                            direction: "upload".to_string(),
                        });
                        continue;
                    }
                    ConflictPolicy::Rename => {
                        remote_path = unique_remote_path(&guard.sftp, &remote_dir, &name).await;
                    }
                    ConflictPolicy::Overwrite => {}
                }
            }

            let transfer_id = Uuid::new_v4();
            let total = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            let part_path = format!("{remote_path}{PART_SUFFIX}");

            if restart {
                let _ = guard.sftp.remove_file(part_path.clone()).await;
            }
            let mut offset = guard
                .sftp
                .metadata(part_path.clone())
                .await
                .ok()
                .and_then(|m| m.size)
                .unwrap_or(0);
            if offset > total {
                // 分片比本地文件还大，说明本地文件已变化，丢弃后重来
                let _ = guard.sftp.remove_file(part_path.clone()).await;
                offset = 0;
            }

            let _ = on_event.send(TransferEvent::Start {
                id: transfer_id,
                name: name.clone(),
                direction: "upload".to_string(),
                total,
                resumed: offset,
                remote_path: remote_path.clone(),
                local_path: Some(local.clone()),
                conflict: conflict.clone(),
            });

            let result = upload_one(
                &guard.sftp,
                &local_path,
                &part_path,
                offset,
                total,
                &on_event,
                transfer_id,
            )
            .await;

            match result {
                Ok(()) => {
                    if let Err(error) = rename_over(&guard.sftp, &part_path, &remote_path).await {
                        let _ = on_event.send(TransferEvent::Error {
                            id: transfer_id,
                            name,
                            message: format!("{error:#}"),
                            direction: "upload".to_string(),
                        });
                        return Err(error);
                    }
                    let _ = on_event.send(TransferEvent::Done {
                        id: transfer_id,
                        name,
                        remote_path,
                        local_path: Some(local),
                        direction: "upload".to_string(),
                    });
                }
                Err(error) => {
                    // 失败保留 .fanssh-part，下次自动续传
                    let _ = on_event.send(TransferEvent::Error {
                        id: transfer_id,
                        name,
                        message: format!("{error:#}"),
                        direction: "upload".to_string(),
                    });
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub async fn download(
        &self,
        id: Uuid,
        remote_path: String,
        local_path: String,
        conflict: String,
        restart: bool,
        on_event: TauriChannel<TransferEvent>,
    ) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let policy = ConflictPolicy::parse(&conflict);

        let name = remote_path
            .rsplit('/')
            .next()
            .unwrap_or("download.bin")
            .to_string();
        let transfer_id = Uuid::new_v4();

        let mut target_path = PathBuf::from(&local_path);
        if target_path.exists() {
            match policy {
                ConflictPolicy::Skip => {
                    let _ = on_event.send(TransferEvent::Skipped {
                        id: transfer_id,
                        name,
                        direction: "download".to_string(),
                    });
                    return Ok(());
                }
                ConflictPolicy::Rename => {
                    target_path = unique_local_path(&target_path);
                }
                ConflictPolicy::Overwrite => {}
            }
        }
        let target_path = target_path.to_string_lossy().to_string();
        let part_path = format!("{target_path}{PART_SUFFIX}");

        if restart {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
        let total = guard
            .sftp
            .metadata(remote_path.clone())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);
        let mut offset = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if offset > total {
            let _ = tokio::fs::remove_file(&part_path).await;
            offset = 0;
        }

        let _ = on_event.send(TransferEvent::Start {
            id: transfer_id,
            name: name.clone(),
            direction: "download".to_string(),
            total,
            resumed: offset,
            remote_path: remote_path.clone(),
            local_path: Some(target_path.clone()),
            conflict: conflict.clone(),
        });

        let result = download_one(
            &guard.sftp,
            &remote_path,
            &part_path,
            offset,
            total,
            &on_event,
            transfer_id,
        )
        .await;

        match result {
            Ok(()) => {
                if let Err(error) = local_rename_over(&part_path, Path::new(&target_path)).await {
                    let _ = on_event.send(TransferEvent::Error {
                        id: transfer_id,
                        name,
                        message: format!("{error:#}"),
                        direction: "download".to_string(),
                    });
                    return Err(error);
                }
                let _ = on_event.send(TransferEvent::Done {
                    id: transfer_id,
                    name,
                    remote_path,
                    local_path: Some(target_path),
                    direction: "download".to_string(),
                });
                Ok(())
            }
            Err(error) => {
                // 失败保留 .fanssh-part，下次自动续传
                let _ = on_event.send(TransferEvent::Error {
                    id: transfer_id,
                    name,
                    message: format!("{error:#}"),
                    direction: "download".to_string(),
                });
                Err(error)
            }
        }
    }

    pub async fn rename(&self, id: Uuid, from: &str, to: &str) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        guard
            .sftp
            .rename(from.to_string(), to.to_string())
            .await
            .context("重命名失败")?;
        Ok(())
    }

    pub async fn mkdir(&self, id: Uuid, path: &str) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        guard
            .sftp
            .create_dir(path.to_string())
            .await
            .context("新建目录失败")?;
        Ok(())
    }

    pub async fn remove_many(&self, id: Uuid, paths: Vec<String>) -> Result<Vec<SftpOpResult>> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let mut results = Vec::with_capacity(paths.len());
        for path in paths {
            let outcome = async {
                let metadata = guard.sftp.symlink_metadata(path.clone()).await?;
                if metadata.is_dir() {
                    guard.sftp.remove_dir(path.clone()).await
                } else {
                    guard.sftp.remove_file(path.clone()).await
                }
            }
            .await;
            results.push(match outcome {
                Ok(()) => SftpOpResult {
                    path,
                    ok: true,
                    error: None,
                },
                Err(error) => SftpOpResult {
                    path,
                    ok: false,
                    error: Some(format!("{error:#}")),
                },
            });
        }
        Ok(results)
    }

    pub async fn read_text(&self, id: Uuid, path: &str) -> Result<SftpTextFile> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let metadata = guard
            .sftp
            .metadata(path.to_string())
            .await
            .context("读取文件信息失败")?;
        let size = metadata.size.unwrap_or(0);
        if size > MAX_TEXT_BYTES {
            bail!("文件大于 2 MB（{size} 字节），请下载到本地后编辑");
        }
        let bytes = guard
            .sftp
            .read(path.to_string())
            .await
            .context("读取远端文件失败")?;
        if bytes.contains(&0) {
            bail!("疑似二进制文件，已拒绝以文本方式打开");
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| anyhow!("文件不是 UTF-8 编码，暂不支持在线编辑"))?;
        Ok(SftpTextFile {
            content,
            mtime: metadata.mtime,
            mode: metadata.permissions,
            size,
        })
    }

    pub async fn write_text(
        &self,
        id: Uuid,
        path: &str,
        content: &str,
        expected_mtime: Option<u32>,
    ) -> Result<SftpTextFile> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;
        let metadata = guard
            .sftp
            .metadata(path.to_string())
            .await
            .context("读取文件信息失败")?;
        if let Some(expected) = expected_mtime {
            if metadata.mtime != Some(expected) {
                bail!("文件已在远端被修改，请重新加载或选择强制保存");
            }
        }
        let mode = metadata.permissions;
        let temp_path = format!("{path}{TEMP_SUFFIX}");
        let _ = guard.sftp.remove_file(temp_path.clone()).await;
        let mut file = guard
            .sftp
            .create(temp_path.clone())
            .await
            .context("创建临时文件失败")?;
        file.write_all(content.as_bytes())
            .await
            .context("写入临时文件失败")?;
        file.shutdown().await.context("关闭临时文件失败")?;
        if let Some(mode) = mode {
            guard
                .sftp
                .set_metadata(
                    temp_path.clone(),
                    FileAttributes {
                        permissions: Some(mode & 0o7777),
                        ..Default::default()
                    },
                )
                .await
                .context("保留文件权限失败")?;
        }
        rename_over(&guard.sftp, &temp_path, path).await?;
        let updated = guard.sftp.metadata(path.to_string()).await.ok();
        Ok(SftpTextFile {
            content: content.to_string(),
            mtime: updated.as_ref().and_then(|m| m.mtime),
            mode: updated.as_ref().and_then(|m| m.permissions).or(mode),
            size: content.len() as u64,
        })
    }

    pub async fn close(&self, id: Uuid) {
        if let Some(entry) = self.sessions.lock().await.remove(&id) {
            let guard = entry.lock().await;
            let _ = guard.sftp.close().await;
        }
    }

    async fn entry(&self, id: Uuid) -> Result<Arc<Mutex<SftpEntry>>> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("SFTP 会话不存在或已关闭"))
    }
}

async fn upload_one(
    sftp: &SftpSession,
    local_path: &PathBuf,
    remote_path: &str,
    offset: u64,
    total: u64,
    on_event: &TauriChannel<TransferEvent>,
    transfer_id: Uuid,
) -> Result<()> {
    let mut source = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("打开本地文件失败: {}", local_path.display()))?;
    if offset > 0 {
        source
            .seek(SeekFrom::Start(offset))
            .await
            .context("定位本地文件失败")?;
    }
    let mut target = if offset > 0 {
        let mut file = sftp
            .open_with_flags(remote_path.to_string(), OpenFlags::WRITE)
            .await
            .with_context(|| format!("打开远端分片失败: {remote_path}"))?;
        file.seek(SeekFrom::Start(offset))
            .await
            .context("定位远端分片失败")?;
        file
    } else {
        sftp.create(remote_path.to_string())
            .await
            .with_context(|| format!("创建远端分片失败: {remote_path}"))?
    };

    let mut buffer = vec![0u8; CHUNK];
    let mut done = offset;
    let started = Instant::now();
    let mut last_report = Instant::now() - Duration::from_secs(1);

    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        target
            .write_all(&buffer[..read])
            .await
            .with_context(|| format!("写入远端文件失败: {remote_path}"))?;
        done += read as u64;
        if last_report.elapsed() >= Duration::from_millis(150) {
            report_progress(
                on_event,
                transfer_id,
                done,
                total,
                offset,
                started,
                "upload",
            );
            last_report = Instant::now();
        }
    }
    target.shutdown().await.context("关闭远端文件失败")?;
    report_progress(
        on_event,
        transfer_id,
        done,
        total,
        offset,
        started,
        "upload",
    );
    Ok(())
}

async fn download_one(
    sftp: &SftpSession,
    remote_path: &str,
    local_part: &str,
    offset: u64,
    total: u64,
    on_event: &TauriChannel<TransferEvent>,
    transfer_id: Uuid,
) -> Result<()> {
    let mut source = sftp
        .open(remote_path.to_string())
        .await
        .with_context(|| format!("打开远端文件失败: {remote_path}"))?;
    if offset > 0 {
        source
            .seek(SeekFrom::Start(offset))
            .await
            .context("定位远端文件失败")?;
    }
    let mut target = if offset > 0 {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(local_part)
            .await
            .with_context(|| format!("打开本地分片失败: {local_part}"))?
    } else {
        tokio::fs::File::create(local_part)
            .await
            .with_context(|| format!("创建本地分片失败: {local_part}"))?
    };

    let mut buffer = vec![0u8; CHUNK];
    let mut done = offset;
    let started = Instant::now();
    let mut last_report = Instant::now() - Duration::from_secs(1);

    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read]).await?;
        done += read as u64;
        if last_report.elapsed() >= Duration::from_millis(150) {
            report_progress(
                on_event,
                transfer_id,
                done,
                total,
                offset,
                started,
                "download",
            );
            last_report = Instant::now();
        }
    }
    target.shutdown().await?;
    report_progress(
        on_event,
        transfer_id,
        done,
        total,
        offset,
        started,
        "download",
    );
    Ok(())
}

/// 先 rename；目标已存在时退化为 remove + rename（SFTP v3 的 rename 不保证覆盖）。
async fn rename_over(sftp: &SftpSession, from: &str, to: &str) -> Result<()> {
    match sftp.rename(from.to_string(), to.to_string()).await {
        Ok(()) => Ok(()),
        Err(first) => {
            if sftp.try_exists(to.to_string()).await.unwrap_or(false)
                && sftp.remove_file(to.to_string()).await.is_ok()
            {
                sftp.rename(from.to_string(), to.to_string())
                    .await
                    .with_context(|| format!("重命名 {from} -> {to} 失败"))?;
                Ok(())
            } else {
                Err(anyhow!(first)).with_context(|| format!("重命名 {from} -> {to} 失败"))
            }
        }
    }
}

async fn local_rename_over(from: &str, to: &Path) -> Result<()> {
    match tokio::fs::rename(from, to).await {
        Ok(()) => Ok(()),
        Err(first) => {
            if to.exists() && tokio::fs::remove_file(to).await.is_ok() {
                tokio::fs::rename(from, to).await?;
                Ok(())
            } else {
                Err(anyhow!(first))
                    .with_context(|| format!("重命名 {from} -> {} 失败", to.display()))
            }
        }
    }
}

async fn unique_remote_path(sftp: &SftpSession, dir: &str, name: &str) -> String {
    let (stem, ext) = split_name(name);
    for index in 1..10_000u32 {
        let candidate = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let path = join_remote(dir, &candidate);
        if !sftp.try_exists(path.clone()).await.unwrap_or(false) {
            return path;
        }
    }
    join_remote(dir, name)
}

fn unique_local_path(path: &Path) -> PathBuf {
    let dir = path.parent().unwrap_or_else(|| Path::new(""));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download.bin".to_string());
    let (stem, ext) = split_name(&name);
    for index in 1..10_000u32 {
        let candidate = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let next = dir.join(candidate);
        if !next.exists() {
            return next;
        }
    }
    path.to_path_buf()
}

fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_string(), name[index + 1..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

fn report_progress(
    on_event: &TauriChannel<TransferEvent>,
    id: Uuid,
    done: u64,
    total: u64,
    offset: u64,
    started: Instant,
    direction: &str,
) {
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    let moved = done.saturating_sub(offset);
    let speed = (moved as f64 / seconds) as u64;
    let _ = on_event.send(TransferEvent::Progress {
        id,
        done,
        total,
        speed_bps: speed,
        direction: direction.to_string(),
    });
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "." {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}
