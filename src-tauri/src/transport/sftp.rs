use anyhow::{Context, Result};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel as TauriChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ipc::dto::{RemoteEntry, TransferEvent};
use crate::session::model::Profile;
use crate::transport::ssh::{connect_profile, ConnectedSsh};
use crate::vault::Vault;

const CHUNK: usize = 32 * 1024;

pub struct SftpEntry {
    sftp: SftpSession,
    _conn: ConnectedSsh,
}

#[derive(Clone, Default)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<Uuid, Arc<Mutex<SftpEntry>>>>>,
}

impl SftpManager {
    pub async fn open(&self, profile: &Profile, vault: &Vault) -> Result<(Uuid, String)> {
        let conn = connect_profile(profile, vault).await?;
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
        on_event: TauriChannel<TransferEvent>,
    ) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;

        for local in local_paths {
            let local_path = PathBuf::from(&local);
            let name = local_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload.bin".to_string());
            let remote_path = join_remote(&remote_dir, &name);
            let transfer_id = Uuid::new_v4();
            let total = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);

            let _ = on_event.send(TransferEvent::Start {
                id: transfer_id,
                name: name.clone(),
                direction: "upload".to_string(),
                total,
            });

            let result = upload_one(
                &guard.sftp,
                &local_path,
                &remote_path,
                total,
                &on_event,
                transfer_id,
                &name,
                "upload",
            )
            .await;

            match result {
                Ok(()) => {
                    let _ = on_event.send(TransferEvent::Done {
                        id: transfer_id,
                        name,
                        remote_path,
                        local_path: Some(local),
                        direction: "upload".to_string(),
                    });
                }
                Err(error) => {
                    // 尽力清理远端半截文件
                    let _ = guard.sftp.remove_file(remote_path.clone()).await;
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
        on_event: TauriChannel<TransferEvent>,
    ) -> Result<()> {
        let entry = self.entry(id).await?;
        let guard = entry.lock().await;

        let name = remote_path
            .rsplit('/')
            .next()
            .unwrap_or("download.bin")
            .to_string();
        let transfer_id = Uuid::new_v4();
        let total = guard
            .sftp
            .metadata(remote_path.clone())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);

        let _ = on_event.send(TransferEvent::Start {
            id: transfer_id,
            name: name.clone(),
            direction: "download".to_string(),
            total,
        });

        let result = download_one(
            &guard.sftp,
            &remote_path,
            &local_path,
            total,
            &on_event,
            transfer_id,
            &name,
        )
        .await;

        match result {
            Ok(()) => {
                let _ = on_event.send(TransferEvent::Done {
                    id: transfer_id,
                    name,
                    remote_path,
                    local_path: Some(local_path),
                    direction: "download".to_string(),
                });
                Ok(())
            }
            Err(error) => {
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
    total: u64,
    on_event: &TauriChannel<TransferEvent>,
    transfer_id: Uuid,
    name: &str,
    direction: &str,
) -> Result<()> {
    let mut source = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("打开本地文件失败: {}", local_path.display()))?;
    let mut target = sftp
        .create(remote_path.to_string())
        .await
        .with_context(|| format!("创建远端文件失败: {remote_path}"))?;

    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
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
            report_progress(on_event, transfer_id, name, done, total, started, direction);
            last_report = Instant::now();
        }
    }
    target.shutdown().await.context("关闭远端文件失败")?;
    report_progress(on_event, transfer_id, name, done, total, started, direction);
    Ok(())
}

async fn download_one(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    total: u64,
    on_event: &TauriChannel<TransferEvent>,
    transfer_id: Uuid,
    name: &str,
) -> Result<()> {
    let mut source = sftp
        .open(remote_path.to_string())
        .await
        .with_context(|| format!("打开远端文件失败: {remote_path}"))?;
    let mut target = tokio::fs::File::create(local_path)
        .await
        .with_context(|| format!("创建本地文件失败: {local_path}"))?;

    let mut buffer = vec![0u8; CHUNK];
    let mut done = 0u64;
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
                name,
                done,
                total,
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
        name,
        done,
        total,
        started,
        "download",
    );
    Ok(())
}

fn report_progress(
    on_event: &TauriChannel<TransferEvent>,
    id: Uuid,
    _name: &str,
    done: u64,
    total: u64,
    started: Instant,
    direction: &str,
) {
    let seconds = started.elapsed().as_secs_f64().max(0.001);
    let speed = (done as f64 / seconds) as u64;
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
