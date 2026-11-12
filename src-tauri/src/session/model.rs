use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 会话/终端唯一标识。序列化为纯字符串，前端直接当 opaque id 使用。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Ssh,
    Rdp,
    Serial,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Password,
    PrivateKey,
    Passphrase,
    Token,
}

impl SecretKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::PrivateKey => "private_key",
            Self::Passphrase => "passphrase",
            Self::Token => "token",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// 认证方式只保存凭据引用（vault item id），不保存明文。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthRef {
    Password { secret: Uuid },
    Key { key: Uuid, passphrase: Option<Uuid> },
    None,
}

impl AuthRef {
    pub fn secret_ids(&self) -> Vec<Uuid> {
        match self {
            Self::Password { secret } => vec![*secret],
            Self::Key { key, passphrase } => {
                let mut v = vec![*key];
                if let Some(p) = passphrase {
                    v.push(*p);
                }
                v
            }
            Self::None => vec![],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JumpHop {
    pub target: Target,
    pub auth: AuthRef,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RdpPrefs {
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    #[serde(default)]
    pub multimon: bool,
    #[serde(default = "default_true")]
    pub clipboard: bool,
    #[serde(default)]
    pub drive_redirect: bool,
    #[serde(default)]
    pub admin_session: bool,
    #[serde(default)]
    pub gateway: Option<String>,
    /// Windows 域/工作组，可选。写入 .rdp 与凭据管理器时拼成 `DOMAIN\user`。
    #[serde(default)]
    pub domain: Option<String>,
}

fn default_width() -> u32 {
    1920
}
fn default_height() -> u32 {
    1080
}
fn default_true() -> bool {
    true
}

impl Default for RdpPrefs {
    fn default() -> Self {
        Self {
            fullscreen: true,
            width: 1920,
            height: 1080,
            multimon: false,
            clipboard: true,
            drive_redirect: false,
            admin_session: false,
            gateway: None,
            domain: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialParity {
    None,
    Odd,
    Even,
}

impl Default for SerialParity {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialFlowControl {
    None,
    Hardware,
    Software,
}

impl Default for SerialFlowControl {
    fn default() -> Self {
        Self::None
    }
}

/// 发送换行策略。串口设备对行尾要求不一，默认原样透传。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerialNewline {
    Raw,
    CrToCrlf,
    LfToCrlf,
}

impl Default for SerialNewline {
    fn default() -> Self {
        Self::Raw
    }
}

/// 串口参数。与凭据无关，随 profile 持久化。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SerialPrefs {
    /// 系统端口名：Windows 为 `COM3`，Unix 为 `/dev/ttyUSB0`。
    #[serde(default)]
    pub port: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default)]
    pub parity: SerialParity,
    #[serde(default)]
    pub flow_control: SerialFlowControl,
    /// DTR 默认拉高：部分交换机 console 需要 DTR 有效才有输出。
    #[serde(default = "default_true")]
    pub dtr: bool,
    /// RTS 默认拉高（硬件流控时由驱动接管）。
    #[serde(default = "default_true")]
    pub rts: bool,
    /// 本地回显默认关闭，避免设备已回显时重复显示。
    #[serde(default)]
    pub local_echo: bool,
    #[serde(default)]
    pub newline: SerialNewline,
}

fn default_baud_rate() -> u32 {
    115200
}
fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> u8 {
    1
}

impl Default for SerialPrefs {
    fn default() -> Self {
        Self {
            port: String::new(),
            baud_rate: default_baud_rate(),
            data_bits: default_data_bits(),
            stop_bits: default_stop_bits(),
            parity: SerialParity::None,
            flow_control: SerialFlowControl::None,
            dtr: true,
            rts: true,
            local_echo: false,
            newline: SerialNewline::Raw,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProfileOptions {
    #[serde(default)]
    pub rdp: Option<RdpPrefs>,
    #[serde(default)]
    pub serial: Option<SerialPrefs>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    pub protocol: Protocol,
    pub target: Target,
    pub auth: AuthRef,
    #[serde(default)]
    pub jump: Vec<JumpHop>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub options: ProfileOptions,
}

impl Profile {
    pub fn secret_ids(&self) -> Vec<Uuid> {
        let mut ids = self.auth.secret_ids();
        for hop in &self.jump {
            ids.extend(hop.auth.secret_ids());
        }
        ids
    }

    pub fn rdp_prefs(&self) -> RdpPrefs {
        self.options.rdp.clone().unwrap_or_default()
    }

    /// 串口参数；未配置时回落到默认值（115200 8N1，无流控）。
    pub fn serial_prefs(&self) -> SerialPrefs {
        self.options.serial.clone().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}
