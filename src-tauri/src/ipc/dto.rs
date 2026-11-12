use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::session::model::ChatMessage;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionState {
    Connecting,
    Authenticating,
    Ready,
    Closed { reason: String },
}

/// 终端流事件。高频数据走 Tauri Channel，不走全局事件总线。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TermEvent {
    State {
        state: SessionState,
    },
    Data {
        seq: u64,
        text: String,
    },
    Title {
        title: String,
    },
    Exit {
        code: Option<i32>,
        reason: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TransferEvent {
    Start {
        id: Uuid,
        name: String,
        direction: String,
        total: u64,
    },
    Progress {
        id: Uuid,
        done: u64,
        total: u64,
        speed_bps: u64,
        direction: String,
    },
    Done {
        id: Uuid,
        name: String,
        remote_path: String,
        local_path: Option<String>,
        direction: String,
    },
    Error {
        id: Uuid,
        name: String,
        message: String,
        direction: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: Option<u32>,
    pub mtime: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SftpOpenResp {
    pub sftp_id: Uuid,
    pub home: String,
}

/// 系统串口枚举结果。`description` 带上厂商/产品/序列号，便于区分同型号设备。
#[derive(Clone, Debug, Serialize)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiSettingsInput {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default)]
    pub secret_id: Option<Uuid>,
    #[serde(default = "default_max_context_kb")]
    pub max_context_kb: u32,
}

fn default_temperature() -> f32 {
    0.2
}
fn default_max_context_kb() -> u32 {
    32
}

#[derive(Clone, Debug, Serialize)]
pub struct AiSettingsView {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub secret_id: Option<Uuid>,
    pub max_context_kb: u32,
    pub has_key: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Nl2CmdResult {
    pub command: String,
    pub shell: String,
    pub explanation: String,
    pub risk: String,
    pub requires_sudo: bool,
    pub assumptions: Vec<String>,
    /// 命中本地硬拦截规则，禁止“插入并执行”。
    pub blocked: bool,
    pub raw: Option<String>,
}

impl Default for Nl2CmdResult {
    fn default() -> Self {
        Self {
            command: String::new(),
            shell: "bash".to_string(),
            explanation: String::new(),
            risk: "high".to_string(),
            requires_sudo: false,
            assumptions: vec![],
            blocked: true,
            raw: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub messages: Vec<ChatMessage>,
    /// chat | explain
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RdpHandleDto {
    pub pid: Option<u32>,
    pub rdp_file: String,
}

// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatusDto {
    /// 当前运行版本（来自 tauri.conf.json）
    pub current_version: String,
    /// 实际使用的更新源地址（来自 tauri.conf.json）
    pub endpoint: String,
    /// 更新通道的 Releases 页面，便携版据此提示下载新包
    pub channel_url: String,
    /// 便携版不执行自更新，只提示去下载新 zip
    pub portable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// 下载安装包的直链（来自 latest.json 的 platforms.url）
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UpdateEvent {
    Downloading,
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    Installed,
}
