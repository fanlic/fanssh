use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::ipc::dto::{AuthPromptItem, TermEvent};
use crate::session::model::{AuthRef, Profile, Target};
use crate::transport::proxy;
use crate::vault::Vault;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
/// 交互认证等待用户输入的最长时间。
const AUTH_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// 键盘交互认证的等待队列。以随机 prompt_id 为键，前端提交后唤醒对应等待。
#[derive(Clone, Default)]
pub struct AuthPrompts {
    pending: Arc<Mutex<HashMap<Uuid, oneshot::Sender<Option<Vec<String>>>>>>,
}

impl AuthPrompts {
    async fn ask(
        &self,
        on_event: &TauriChannel<TermEvent>,
        name: String,
        instructions: String,
        prompts: Vec<russh::client::Prompt>,
    ) -> Result<Vec<String>> {
        let prompt_id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(prompt_id, tx);
        let _ = on_event.send(TermEvent::AuthPrompt {
            prompt_id,
            name,
            instructions,
            prompts: prompts
                .iter()
                .map(|item| AuthPromptItem {
                    prompt: item.prompt.clone(),
                    echo: item.echo,
                })
                .collect(),
        });
        match tokio::time::timeout(AUTH_PROMPT_TIMEOUT, rx).await {
            Ok(Ok(Some(responses))) => Ok(responses),
            Ok(Ok(None)) => bail!("已取消键盘交互认证"),
            Ok(Err(_)) => bail!("交互认证会话已关闭"),
            Err(_) => {
                self.pending.lock().await.remove(&prompt_id);
                bail!("等待交互认证输入超时（{} 秒）", AUTH_PROMPT_TIMEOUT.as_secs())
            }
        }
    }

    /// 前端提交或取消。返回 false 表示没有匹配的等待项（可能已超时）。
    pub async fn respond(&self, prompt_id: Uuid, responses: Option<Vec<String>>) -> bool {
        let mut guard = self.pending.lock().await;
        match guard.remove(&prompt_id) {
            Some(tx) => {
                let _ = tx.send(responses);
                true
            }
            None => false,
        }
    }
}

#[derive(Clone, Copy)]
pub struct AuthUi<'a> {
    pub prompts: &'a AuthPrompts,
    pub on_event: &'a TauriChannel<TermEvent>,
}

pub struct ClientHandler {
    label: String,
}

impl ClientHandler {
    fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // v1 骨架：接受并记录主机密钥，尚未实现 known_hosts 持久化校验。
        log::info!(
            "[ssh] {} 主机密钥: {:?}",
            self.label,
            server_public_key
        );
        Ok(true)
    }
}

/// 已建立的 SSH 连接。`_intermediates` 必须与目标连接同生命周期存活，
/// 否则跳板通道会被提前关闭。
pub struct ConnectedSsh {
    pub handle: Arc<Handle<ClientHandler>>,
    pub _intermediates: Vec<Handle<ClientHandler>>,
}

pub async fn connect_profile(
    profile: &Profile,
    vault: &Vault,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<ConnectedSsh> {
    let prefs = profile.ssh_prefs();
    let timeout = Duration::from_millis(prefs.timeout_ms.max(1000));
    let keepalive = if prefs.keepalive_ms == 0 {
        None
    } else {
        Some(Duration::from_millis(prefs.keepalive_ms))
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(900)),
        keepalive_interval: keepalive,
        keepalive_max: 3,
        nodelay: true,
        window_size: 2 * 1024 * 1024,
        maximum_packet_size: 32768,
        ..Default::default()
    });

    let mut intermediates: Vec<Handle<ClientHandler>> = Vec::new();
    let mut handle: Handle<ClientHandler>;

    if let Some(first) = profile.jump.first() {
        let stream =
            proxy::tcp_connect(&first.target.host, first.target.port, &prefs, timeout).await?;
        handle = connect_stream_timeout(
            config.clone(),
            stream,
            &first.target.host,
            timeout,
            "连接跳板机",
        )
        .await?;
        auth_with_timeout(&mut handle, &first.target, &first.auth, vault, auth_ui).await?;

        for hop in profile.jump.iter().skip(1) {
            let channel = ssh_timeout(
                "打开跳板转发通道",
                handle.channel_open_direct_tcpip(
                    hop.target.host.clone(),
                    hop.target.port as u32,
                    "127.0.0.1",
                    0,
                ),
            )
            .await?;
            let mut next = connect_stream_timeout(
                config.clone(),
                channel.into_stream(),
                &hop.target.host,
                timeout,
                "通过跳板建立连接",
            )
            .await?;
            auth_with_timeout(&mut next, &hop.target, &hop.auth, vault, auth_ui).await?;
            intermediates.push(handle);
            handle = next;
        }

        let channel = ssh_timeout(
            "打开目标转发通道",
            handle.channel_open_direct_tcpip(
                profile.target.host.clone(),
                profile.target.port as u32,
                "127.0.0.1",
                0,
            ),
        )
        .await?;
        let mut next = connect_stream_timeout(
            config.clone(),
            channel.into_stream(),
            &profile.target.host,
            timeout,
            "通过跳板连接目标主机",
        )
        .await?;
        auth_with_timeout(&mut next, &profile.target, &profile.auth, vault, auth_ui).await?;
        intermediates.push(handle);
        handle = next;
    } else {
        let stream = proxy::tcp_connect(
            &profile.target.host,
            profile.target.port,
            &prefs,
            timeout,
        )
        .await?;
        handle = connect_stream_timeout(
            config.clone(),
            stream,
            &profile.target.host,
            timeout,
            "建立 SSH 连接",
        )
        .await?;
        auth_with_timeout(&mut handle, &profile.target, &profile.auth, vault, auth_ui).await?;
    }

    Ok(ConnectedSsh {
        handle: Arc::new(handle),
        _intermediates: intermediates,
    })
}

async fn connect_stream_timeout<S>(
    config: Arc<client::Config>,
    stream: S,
    label: &str,
    timeout: Duration,
    what: &str,
) -> Result<Handle<ClientHandler>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::time::timeout(
        timeout,
        client::connect_stream(config, stream, ClientHandler::new(label)),
    )
    .await
    .map_err(|_| anyhow!("{what}超时（{}ms）", timeout.as_millis()))?
    .with_context(|| what.to_string())
}

async fn auth_with_timeout(
    handle: &mut Handle<ClientHandler>,
    target: &Target,
    auth: &AuthRef,
    vault: &Vault,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<()> {
    tokio::time::timeout(
        AUTH_TIMEOUT,
        authenticate(handle, target, auth, vault, auth_ui),
    )
    .await
    .map_err(|_| anyhow!("认证超时（{}s）", AUTH_TIMEOUT.as_secs()))?
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    target: &Target,
    auth: &AuthRef,
    vault: &Vault,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<()> {
    match auth {
        AuthRef::Password { secret } => {
            let password = vault.get(secret).context("读取密码凭据失败")?;
            let result = handle
                .authenticate_password(target.user.as_str(), password.as_str())
                .await
                .context("密码认证请求失败")?;
            if !result.success() {
                bail!(
                    "认证失败：{}@{} 的用户名或密码不正确",
                    target.user,
                    target.host
                );
            }
        }
        AuthRef::Key { key, passphrase } => {
            let pem = vault.get(key).context("读取私钥凭据失败")?;
            let mut private_key = PrivateKey::from_openssh(pem.as_bytes())
                .context("私钥解析失败：请确认是 OpenSSH PEM 格式")?;
            if private_key.is_encrypted() {
                let passphrase = match passphrase {
                    Some(id) => Some(vault.get(id).context("读取私钥 passphrase 失败")?),
                    None => None,
                }
                .ok_or_else(|| anyhow!("私钥已加密，但未配置 passphrase"))?;
                private_key = private_key
                    .decrypt(passphrase.as_bytes())
                    .context("私钥解密失败：passphrase 不正确")?;
            }
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            let result = handle
                .authenticate_publickey(
                    target.user.as_str(),
                    PrivateKeyWithHashAlg::new(Arc::new(private_key), hash),
                )
                .await
                .context("公钥认证请求失败")?;
            if !result.success() {
                bail!(
                    "认证失败：{}@{} 拒绝了该密钥",
                    target.user,
                    target.host
                );
            }
        }
        AuthRef::KeyboardInteractive => {
            let ui = auth_ui.ok_or_else(|| {
                anyhow!("该服务器要求键盘交互认证，但当前入口无法弹出输入框")
            })?;
            let mut response = handle
                .authenticate_keyboard_interactive_start(target.user.as_str(), None::<String>)
                .await
                .context("键盘交互认证请求失败")?;
            loop {
                match response {
                    KeyboardInteractiveAuthResponse::Success => break,
                    KeyboardInteractiveAuthResponse::Failure { .. } => {
                        bail!(
                            "认证失败：{}@{} 的键盘交互认证未通过",
                            target.user,
                            target.host
                        );
                    }
                    KeyboardInteractiveAuthResponse::InfoRequest {
                        name,
                        instructions,
                        prompts,
                    } => {
                        let answers = ui
                            .prompts
                            .ask(ui.on_event, name, instructions, prompts)
                            .await?;
                        response = handle
                            .authenticate_keyboard_interactive_respond(answers)
                            .await
                            .context("键盘交互认证应答失败")?;
                    }
                }
            }
        }
        AuthRef::None => {}
    }
    Ok(())
}

async fn ssh_timeout<F, T>(what: &str, future: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T, russh::Error>>,
{
    tokio::time::timeout(CONNECT_TIMEOUT, future)
        .await
        .map_err(|_| anyhow!("{what}超时（{}s）", CONNECT_TIMEOUT.as_secs()))?
        .with_context(|| what.to_string())
}
