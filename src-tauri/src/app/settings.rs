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

/// 外观：主题预设与自定义色。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceSettings {
    /// 预设 id，如 dark / light / vermilion。
    pub preset: String,
    pub theme_color: String,
    pub background_color: String,
    pub nav_color: String,
    pub follow_system: bool,
    pub system_font: String,
}

fn default_preset() -> String {
    "dark".to_string()
}
fn default_theme_color() -> String {
    "#3dbe71".to_string()
}
fn default_background_color() -> String {
    "#141414".to_string()
}
fn default_nav_color() -> String {
    "#313131".to_string()
}
fn default_system_font() -> String {
    "default".to_string()
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            preset: default_preset(),
            theme_color: default_theme_color(),
            background_color: default_background_color(),
            nav_color: default_nav_color(),
            follow_system: false,
            system_font: default_system_font(),
        }
    }
}

/// 终端基础配置，创建终端时读取，修改后实时作用到已打开会话。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalSettings {
    pub font_family: String,
    /// normal / 300 / 400 / 500 / 600 / bold
    pub normal_weight: String,
    pub bold_weight: String,
    pub scrollback: u32,
    pub font_size: u16,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub cursor_blink: bool,
    /// bar / block / underline
    pub cursor_style: String,
    /// none / outline / block / bar / underline
    pub inactive_cursor_style: String,
    /// floating / hidden / fixed
    pub quick_input: String,
    pub wheel_zoom: bool,
    pub copy_on_select: bool,
    /// menu / paste
    pub right_click: String,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_family:
                "\"Ubuntu\", \"Menlo\", \"Monaco\", \"Consolas\", \"Courier New\", \"Noto Sans Mono CJK SC\", monospace"
                    .to_string(),
            normal_weight: "normal".to_string(),
            bold_weight: "bold".to_string(),
            scrollback: 3000,
            font_size: 16,
            line_height: 1.0,
            letter_spacing: 0.0,
            cursor_blink: true,
            cursor_style: "bar".to_string(),
            inactive_cursor_style: "none".to_string(),
            quick_input: "floating".to_string(),
            wheel_zoom: true,
            copy_on_select: false,
            right_click: "menu".to_string(),
        }
    }
}

/// 应用级快捷键。终端内的 Ctrl+C/V/F/L 不在此表内，永远交给终端与系统。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ShortcutSettings {
    pub open_settings: String,
    pub global_search: String,
    pub next_tab: String,
    pub prev_tab: String,
    pub close_tab: String,
    pub zoom_in: String,
    pub zoom_out: String,
    pub toggle_sidebar: String,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            open_settings: "Ctrl+,".to_string(),
            global_search: "Ctrl+Shift+F".to_string(),
            next_tab: "Ctrl+Tab".to_string(),
            prev_tab: "Ctrl+Shift+Tab".to_string(),
            close_tab: "Ctrl+W".to_string(),
            zoom_in: "Ctrl+=".to_string(),
            zoom_out: "Ctrl+-".to_string(),
            toggle_sidebar: "Ctrl+Shift+B".to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UiSettings {
    pub appearance: AppearanceSettings,
    pub terminal: TerminalSettings,
    pub shortcuts: ShortcutSettings,
}

#[derive(Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    ai: AiSettingsFile,
    #[serde(default)]
    ui: UiSettings,
}

pub struct SettingsStore {
    path: PathBuf,
    ai: Mutex<AiSettingsFile>,
    ui: Mutex<UiSettings>,
}

impl SettingsStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).context("创建数据目录失败")?;
        let path = dir.join("settings.json");
        let (ai, ui) = if path.exists() {
            let bytes = std::fs::read(&path).context("读取 settings.json 失败")?;
            let file = serde_json::from_slice::<SettingsFile>(&bytes)
                .context("解析 settings.json 失败")?;
            (file.ai, file.ui)
        } else {
            (AiSettingsFile::default(), UiSettings::default())
        };
        Ok(Self {
            path,
            ai: Mutex::new(ai),
            ui: Mutex::new(ui),
        })
    }

    pub fn ai(&self) -> AiSettingsFile {
        self.ai.lock().unwrap().clone()
    }

    pub fn save_ai(&self, settings: AiSettingsFile) -> Result<AiSettingsFile> {
        let mut guard = self.ai.lock().unwrap();
        *guard = settings.clone();
        let file = SettingsFile {
            ai: settings.clone(),
            ui: self.ui.lock().unwrap().clone(),
        };
        self.write(&file)?;
        Ok(settings)
    }

    pub fn ui(&self) -> UiSettings {
        self.ui.lock().unwrap().clone()
    }

    pub fn save_ui(&self, settings: UiSettings) -> Result<UiSettings> {
        let mut guard = self.ui.lock().unwrap();
        *guard = settings.clone();
        let file = SettingsFile {
            ai: self.ai.lock().unwrap().clone(),
            ui: settings.clone(),
        };
        self.write(&file)?;
        Ok(settings)
    }

    fn write(&self, file: &SettingsFile) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(file)?;
        write_atomic(&self.path, &bytes)
    }
}
