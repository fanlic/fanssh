use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::session::model::Profile;
use crate::util::{now_unix, write_atomic};

#[derive(Serialize, Deserialize)]
struct ProfilesFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    profiles: Vec<Profile>,
}

fn default_version() -> u32 {
    1
}

#[derive(Serialize, Deserialize)]
struct ExportEnvelope {
    version: u32,
    exported_at: i64,
    profiles: Vec<Profile>,
}

/// 服务器配置存储。只保存配置和凭据引用，绝不保存明文凭据。
pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
}

impl ProfileStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("profiles.json");
        let profiles = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 profiles.json 失败")?;
            let file: ProfilesFile =
                serde_json::from_slice(&bytes).context("解析 profiles.json 失败")?;
            file.profiles
        } else {
            vec![]
        };
        Ok(Self {
            path,
            profiles: Mutex::new(profiles),
        })
    }

    pub fn list(&self) -> Vec<Profile> {
        self.profiles.lock().unwrap().clone()
    }

    pub fn get(&self, id: &Uuid) -> Option<Profile> {
        self.profiles
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == *id)
            .cloned()
    }

    pub fn upsert(&self, mut profile: Profile) -> Result<Profile> {
        if profile.id.is_nil() {
            profile.id = Uuid::new_v4();
        }
        validate(&profile)?;
        let mut profiles = self.profiles.lock().unwrap();
        if let Some(existing) = profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        self.persist(&profiles)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &Uuid) -> Result<Option<Profile>> {
        let mut profiles = self.profiles.lock().unwrap();
        let index = profiles.iter().position(|p| p.id == *id);
        let removed = index.map(|i| profiles.remove(i));
        if removed.is_some() {
            self.persist(&profiles)?;
        }
        Ok(removed)
    }

    pub fn export(&self, path: &Path) -> Result<usize> {
        let profiles = self.profiles.lock().unwrap().clone();
        let envelope = ExportEnvelope {
            version: 1,
            exported_at: now_unix(),
            profiles: profiles.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&envelope)?;
        write_atomic(path, &bytes)?;
        Ok(profiles.len())
    }

    pub fn import(&self, path: &Path) -> Result<usize> {
        let bytes = std::fs::read(path).context("读取导入文件失败")?;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("导入文件不是合法 JSON")?;
        let raw = if value.is_array() {
            value
        } else {
            value
                .get("profiles")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("导入文件缺少 profiles 字段"))?
        };
        let mut incoming: Vec<Profile> =
            serde_json::from_value(raw).context("导入文件中的服务器配置格式不正确")?;

        let mut profiles = self.profiles.lock().unwrap();
        let mut existing_ids: std::collections::HashSet<Uuid> =
            profiles.iter().map(|p| p.id).collect();
        let mut count = 0usize;
        for profile in incoming.iter_mut() {
            if profile.id.is_nil() || existing_ids.contains(&profile.id) {
                profile.id = Uuid::new_v4();
            }
            existing_ids.insert(profile.id);
            if validate(profile).is_ok() {
                profiles.push(profile.clone());
                count += 1;
            }
        }
        self.persist(&profiles)?;
        Ok(count)
    }

    fn persist(&self, profiles: &[Profile]) -> Result<()> {
        let file = ProfilesFile {
            version: 1,
            profiles: profiles.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&file)?;
        write_atomic(&self.path, &bytes)
    }
}

fn validate(profile: &Profile) -> Result<()> {
    if profile.name.trim().is_empty() {
        bail!("名称不能为空");
    }
    if profile.target.host.trim().is_empty() {
        bail!("主机地址不能为空");
    }
    if profile.target.port == 0 {
        bail!("端口必须在 1-65535 之间");
    }
    match profile.protocol {
        crate::session::model::Protocol::Ssh => {
            if profile.target.user.trim().is_empty() {
                bail!("SSH 用户名不能为空");
            }
        }
        crate::session::model::Protocol::Rdp => {}
    }
    if profile.jump.len() > 1 {
        bail!("当前版本最多支持一层跳板机");
    }
    if let Some(hop) = profile.jump.first() {
        if hop.target.host.trim().is_empty() || hop.target.user.trim().is_empty() {
            bail!("跳板机的主机和用户名不能为空");
        }
    }
    Ok(())
}
