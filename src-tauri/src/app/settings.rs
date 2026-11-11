use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

use crate::util::write_atomic;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiSettingsFile {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default)]
    pub secret_id: Option<Uuid>,
    #[serde(default = "default_max_context_kb")]
    pub max_context_kb: u32,
}

fn default_provider() -> String {
    "ollama".to_string()
}
fn default_base_url() -> String {
    "http://127.0.0.1:11434".to_string()
}
fn default_model() -> String {
    "qwen2.5-coder:7b".to_string()
}
fn default_temperature() -> f32 {
    0.2
}
fn default_max_context_kb() -> u32 {
    32
}

impl Default for AiSettingsFile {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            base_url: default_base_url(),
            model: default_model(),
            temperature: default_temperature(),
            secret_id: None,
            max_context_kb: default_max_context_kb(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    ai: AiSettingsFile,
}

pub struct SettingsStore {
    path: PathBuf,
    ai: Mutex<AiSettingsFile>,
}

impl SettingsStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("settings.json");
        let ai = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 settings.json 失败")?;
            serde_json::from_slice::<SettingsFile>(&bytes)
                .context("解析 settings.json 失败")?
                .ai
        } else {
            AiSettingsFile::default()
        };
        Ok(Self {
            path,
            ai: Mutex::new(ai),
        })
    }

    pub fn ai(&self) -> AiSettingsFile {
        self.ai.lock().unwrap().clone()
    }

    pub fn save_ai(&self, settings: AiSettingsFile) -> Result<AiSettingsFile> {
        let mut guard = self.ai.lock().unwrap();
        *guard = settings.clone();
        let file = SettingsFile { ai: settings.clone() };
        let bytes = serde_json::to_vec_pretty(&file)?;
        write_atomic(&self.path, &bytes)?;
        Ok(settings)
    }
}
