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
    Telnet,
    Tunnel,
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
    /// SSH 键盘交互认证：每轮提示都由用户在连接时输入，不落盘。
    KeyboardInteractive,
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
            Self::KeyboardInteractive => vec![],
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EnvVar {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
}

/// SSH 连接扩展参数。全部随 profile 持久化，不含明文凭据。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SshPrefs {
    /// 建立 TCP 连接的超时（毫秒），默认 20000。
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// 心跳间隔（毫秒），0 表示关闭，默认 5000。
    #[serde(default = "default_keepalive_ms")]
    pub keepalive_ms: u64,
    /// 终端显示编码：utf-8 / gbk / gb18030 / big5，默认 utf-8。
    #[serde(default)]
    pub encoding: Option<String>,
    /// PTY 终端类型，留空使用 xterm-256color。
    #[serde(default)]
    pub terminal_type: Option<String>,
    /// socks5:// 或 http:// 代理地址；留空直连。
    #[serde(default)]
    pub proxy: Option<String>,
    /// 关闭代理（优先于 proxy 字段）。
    #[serde(default)]
    pub proxy_disabled: bool,
    /// 登录后自动执行的初始化命令。
    #[serde(default)]
    pub init_command: Option<String>,
    /// 登录后自动切换的默认路径。
    #[serde(default)]
    pub default_path: Option<String>,
    /// 定时发送的保活命令。
    #[serde(default)]
    pub keepalive_command: Option<String>,
    /// 保活命令发送周期（毫秒），默认 60000。
    #[serde(default = "default_keepalive_command_ms")]
    pub keepalive_command_ms: u64,
    /// 会话环境变量，登录后通过 SSH set_env 下发。
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// 禁止列表监控开启（当前仅保存）。
    #[serde(default)]
    pub monitor_disabled: bool,
    /// 禁用 pwd 自动跳转（当前仅保存）。
    #[serde(default)]
    pub disable_pwd_jump: bool,
    /// 启用 X11 转发（当前仅保存）。
    #[serde(default)]
    pub x11: bool,
    /// X11 Cookie 模式（当前仅保存）。
    #[serde(default)]
    pub x11_cookie: Option<String>,
    /// 主机密钥算法（当前仅保存）。
    #[serde(default)]
    pub host_key_algorithms: Option<String>,
    /// Cipher 算法（当前仅保存）。
    #[serde(default)]
    pub ciphers: Option<String>,
    /// 密钥交换算法（当前仅保存）。
    #[serde(default)]
    pub kex_algorithms: Option<String>,
}

fn default_timeout_ms() -> u64 {
    20_000
}
fn default_keepalive_ms() -> u64 {
    5_000
}
fn default_keepalive_command_ms() -> u64 {
    60_000
}

impl Default for SshPrefs {
    fn default() -> Self {
        Self {
            timeout_ms: default_timeout_ms(),
            keepalive_ms: default_keepalive_ms(),
            encoding: None,
            terminal_type: None,
            proxy: None,
            proxy_disabled: false,
            init_command: None,
            default_path: None,
            keepalive_command: None,
            keepalive_command_ms: default_keepalive_command_ms(),
            env: Vec::new(),
            monitor_disabled: false,
            disable_pwd_jump: false,
            x11: false,
            x11_cookie: None,
            host_key_algorithms: None,
            ciphers: None,
            kex_algorithms: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    /// 本机监听，通过服务器访问远端目标。
    Local,
    /// 服务器监听，回连本机目标。
    Remote,
    /// 本机提供 SOCKS5 动态代理，由客户端指定目标。
    Dynamic,
}

/// 一条转发路由。`local_*` 对本地/动态转发是本机监听地址，对远程转发是服务器监听地址。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TunnelRoute {
    pub id: Uuid,
    pub kind: TunnelKind,
    #[serde(default = "default_tunnel_bind")]
    pub local_host: String,
    pub local_port: u16,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default)]
    pub remote_port: u16,
}

fn default_tunnel_bind() -> String {
    "127.0.0.1".to_string()
}

/// 隧道配置。服务器引用已有 SSH 配置，凭据只保存在该 SSH 配置的 vault 引用里。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TunnelPrefs {
    /// 承载隧道的 SSH 服务器配置 id。
    #[serde(default)]
    pub server_id: Option<Uuid>,
    /// 允许隧道意外断开后自动重连。
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub routes: Vec<TunnelRoute>,
}

impl Default for TunnelPrefs {
    fn default() -> Self {
        Self {
            server_id: None,
            auto_reconnect: true,
            routes: Vec::new(),
        }
    }
}

/// Telnet 扩展参数。标准模式不做任何按键转换。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TelnetPrefs {
    #[serde(default)]
    pub enable_mapping: bool,
    #[serde(default = "default_telnet_preset")]
    pub mapping_preset: String,
}

fn default_telnet_preset() -> String {
    "standard".to_string()
}

impl Default for TelnetPrefs {
    fn default() -> Self {
        Self {
            enable_mapping: false,
            mapping_preset: default_telnet_preset(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProfileOptions {
    #[serde(default)]
    pub rdp: Option<RdpPrefs>,
    #[serde(default)]
    pub serial: Option<SerialPrefs>,
    #[serde(default)]
    pub ssh: Option<SshPrefs>,
    #[serde(default)]
    pub telnet: Option<TelnetPrefs>,
    #[serde(default)]
    pub tunnel: Option<TunnelPrefs>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    /// 主机备注，对应参考文档「主机备注」。
    #[serde(default)]
    pub remark: Option<String>,
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

    /// SSH 扩展参数；未配置时回落到默认值。
    pub fn ssh_prefs(&self) -> SshPrefs {
        self.options.ssh.clone().unwrap_or_default()
    }

    /// 隧道参数；未配置时回落到默认值。
    pub fn tunnel_prefs(&self) -> TunnelPrefs {
        self.options.tunnel.clone().unwrap_or_default()
    }

    /// Telnet 参数；未配置时回落到默认值。
    pub fn telnet_prefs(&self) -> TelnetPrefs {
        self.options.telnet.clone().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}
