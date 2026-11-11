use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

use crate::app::settings::SettingsStore;
use crate::profile::ProfileStore;
use crate::session::manager::SshManager;
use crate::transport::sftp::SftpManager;
use crate::vault::Vault;

pub struct AppState {
    pub data_dir: PathBuf,
    pub vault: Arc<Vault>,
    pub profiles: Arc<ProfileStore>,
    pub settings: Arc<SettingsStore>,
    pub ssh: SshManager,
    pub sftp: SftpManager,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn init(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir).context("创建应用数据目录失败")?;
        let vault = Arc::new(Vault::open(&data_dir)?);
        let profiles = Arc::new(ProfileStore::open(&data_dir)?);
        let settings = Arc::new(SettingsStore::open(&data_dir)?);
        let http = reqwest::Client::builder()
            .user_agent("FanSSH/1.0")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .build()
            .context("初始化 HTTP 客户端失败")?;
        Ok(Self {
            data_dir,
            vault,
            profiles,
            settings,
            ssh: SshManager::default(),
            sftp: SftpManager::default(),
            http,
        })
    }
}

/// 数据目录解析顺序：
/// 1. FANSSH_DATA_DIR 环境变量（调试/测试）
/// 2. 可执行文件旁的 portable.marker -> 便携模式，数据放在 exe 同级 data/
/// 3. 系统应用数据目录（Windows: %APPDATA%\com.fanssh.app）
pub fn resolve_data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    if let Ok(custom) = std::env::var("FANSSH_DATA_DIR") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("portable.marker").exists() {
                return Ok(dir.join("data"));
            }
        }
    }

    app.path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("无法确定应用数据目录: {e}"))
}
