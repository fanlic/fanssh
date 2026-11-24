use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelOpenFailure};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use uuid::Uuid;

use crate::ipc::dto::{AuthPromptItem, SessionState, TermEvent};
use crate::known_hosts::KnownHosts;
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
    host_keys: Arc<Mutex<HashMap<Uuid, oneshot::Sender<HostKeyDecision>>>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyDecision {
    Cancel,
    Once,
    Save,
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
                bail!(
                    "等待交互认证输入超时（{} 秒）",
                    AUTH_PROMPT_TIMEOUT.as_secs()
                )
            }
        }
    }

    pub async fn respond_host_key(&self, prompt_id: Uuid, decision: HostKeyDecision) -> bool {
        self.host_keys
            .lock()
            .await
            .remove(&prompt_id)
            .is_some_and(|sender| sender.send(decision).is_ok())
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
    host: String,
    port: u16,
    known_hosts: Arc<KnownHosts>,
    host_key_ui: Option<(AuthPrompts, TauriChannel<TermEvent>, Arc<Notify>)>,
    accepted_key: Option<(String, String)>,
    /// 远程端口转发：服务端每接受一个连接就打开 forwarded-tcpip 通道，
    /// 这里接受通道后交给隧道任务处理。没有隧道时直接拒绝。
    forward_tx: Option<mpsc::UnboundedSender<Channel<russh::client::Msg>>>,
}

impl ClientHandler {
    fn new(
        target: &Target,
        known_hosts: Arc<KnownHosts>,
        forward_tx: Option<mpsc::UnboundedSender<Channel<russh::client::Msg>>>,
        host_key_ui: Option<(AuthPrompts, TauriChannel<TermEvent>, Arc<Notify>)>,
    ) -> Self {
        Self {
            label: format!("{}:{}", target.host, target.port),
            host: target.host.clone(),
            port: target.port,
            known_hosts,
            host_key_ui,
            accepted_key: None,
            forward_tx,
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let algorithm = key.algorithm().as_str().to_string();
        let fingerprint = key.fingerprint(Default::default()).to_string();
        if let Some((previous_algorithm, previous_fingerprint)) = &self.accepted_key {
            return Ok(previous_algorithm == &algorithm && previous_fingerprint == &fingerprint);
        }

        if let Some((_, events, _)) = &self.host_key_ui {
            let _ = events.send(TermEvent::State {
                state: SessionState::VerifyingHost,
            });
        }
        if !self
            .known_hosts
            .verify(&self.host, self.port, &algorithm, &fingerprint, false)?
        {
            let Some((prompts, events, waiting)) = &self.host_key_ui else {
                bail!(
                    "尚未信任 SSH 主机 {}。请先打开 SSH 会话并确认主机指纹。",
                    self.label
                );
            };
            let prompt_id = Uuid::new_v4();
            let (sender, response) = oneshot::channel();
            prompts.host_keys.lock().await.insert(prompt_id, sender);
            waiting.notify_one();
            let dispatched = events.send(TermEvent::HostKeyPrompt {
                prompt_id,
                host: self.host.clone(),
                port: self.port,
                algorithm: algorithm.clone(),
                fingerprint: fingerprint.clone(),
            });
            if dispatched.is_err() {
                prompts.host_keys.lock().await.remove(&prompt_id);
                bail!("无法显示 SSH 主机指纹确认");
            }
            let decision = tokio::time::timeout(AUTH_PROMPT_TIMEOUT, response).await;
            prompts.host_keys.lock().await.remove(&prompt_id);
            let save = match decision {
                Ok(Ok(HostKeyDecision::Save)) => true,
                Ok(Ok(HostKeyDecision::Once)) => false,
                Ok(_) => bail!("已取消 SSH 主机指纹确认"),
                Err(_) => bail!("等待 SSH 主机指纹确认超时"),
            };
            // Recheck under the store lock in case a concurrent connection saved a key.
            self.known_hosts
                .verify(&self.host, self.port, &algorithm, &fingerprint, save)?;
        }
        self.accepted_key = Some((algorithm.clone(), fingerprint.clone()));
        log::info!(
            "[ssh] {} 主机密钥已验证: {} {}",
            self.label,
            algorithm,
            fingerprint
        );
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        match self.forward_tx.as_ref() {
            Some(tx) => {
                reply.accept().await;
                log::info!(
                    "[ssh] {} 转发连接 {}:{} <- {}:{}",
                    self.label,
                    connected_address,
                    connected_port,
                    originator_address,
                    originator_port
                );
                let _ = tx.send(channel);
            }
            None => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }
        Ok(())
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
    known_hosts: Arc<KnownHosts>,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<ConnectedSsh> {
    connect_profile_with_forward(profile, vault, known_hosts, auth_ui, None).await
}

/// 与 `connect_profile` 相同，额外把服务端打开的远程转发通道交给 `forward_tx`。
pub async fn connect_profile_with_forward(
    profile: &Profile,
    vault: &Vault,
    known_hosts: Arc<KnownHosts>,
    auth_ui: Option<AuthUi<'_>>,
    forward_tx: Option<mpsc::UnboundedSender<Channel<russh::client::Msg>>>,
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
            &first.target,
            known_hosts.clone(),
            timeout,
            "连接跳板机",
            forward_tx.clone(),
            auth_ui,
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
                &hop.target,
                known_hosts.clone(),
                timeout,
                "通过跳板建立连接",
                forward_tx.clone(),
                auth_ui,
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
            &profile.target,
            known_hosts.clone(),
            timeout,
            "通过跳板连接目标主机",
            forward_tx.clone(),
            auth_ui,
        )
        .await?;
        auth_with_timeout(&mut next, &profile.target, &profile.auth, vault, auth_ui).await?;
        intermediates.push(handle);
        handle = next;
    } else {
        let stream =
            proxy::tcp_connect(&profile.target.host, profile.target.port, &prefs, timeout).await?;
        handle = connect_stream_timeout(
            config.clone(),
            stream,
            &profile.target,
            known_hosts,
            timeout,
            "建立 SSH 连接",
            forward_tx.clone(),
            auth_ui,
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
    target: &Target,
    known_hosts: Arc<KnownHosts>,
    timeout: Duration,
    what: &str,
    forward_tx: Option<mpsc::UnboundedSender<Channel<russh::client::Msg>>>,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<Handle<ClientHandler>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let waiting = Arc::new(Notify::new());
    let host_key_ui = auth_ui.map(|ui| (ui.prompts.clone(), ui.on_event.clone(), waiting.clone()));
    let connection = client::connect_stream(
        config,
        stream,
        ClientHandler::new(target, known_hosts, forward_tx, host_key_ui),
    );
    tokio::pin!(connection);
    tokio::select! {
        result = &mut connection => result,
        _ = waiting.notified() => {
            tokio::time::timeout(AUTH_PROMPT_TIMEOUT + timeout, &mut connection)
                .await
                .map_err(|_| anyhow!("等待 SSH 主机指纹确认超时"))?
        }
        _ = tokio::time::sleep(timeout) => bail!("{what}超时（{}ms）", timeout.as_millis()),
    }
    .with_context(|| what.to_string())
}

async fn auth_with_timeout(
    handle: &mut Handle<ClientHandler>,
    target: &Target,
    auth: &AuthRef,
    vault: &Vault,
    auth_ui: Option<AuthUi<'_>>,
) -> Result<()> {
    if let Some(ui) = auth_ui {
        let _ = ui.on_event.send(TermEvent::State {
            state: SessionState::Authenticating,
        });
    }
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
                bail!("认证失败：{}@{} 拒绝了该密钥", target.user, target.host);
            }
        }
        AuthRef::KeyboardInteractive => {
            let ui = auth_ui
                .ok_or_else(|| anyhow!("该服务器要求键盘交互认证，但当前入口无法弹出输入框"))?;
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
