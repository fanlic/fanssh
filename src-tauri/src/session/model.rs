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
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProfileOptions {
    #[serde(default)]
    pub rdp: Option<RdpPrefs>,
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}
