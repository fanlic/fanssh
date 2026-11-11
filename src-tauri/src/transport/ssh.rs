use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::sync::Arc;
use std::time::Duration;

use crate::session::model::{AuthRef, Profile, Target};
use crate::vault::Vault;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const AUTH_TIMEOUT: Duration = Duration::from_secs(20);

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
    pub handle: Handle<ClientHandler>,
    pub _intermediates: Vec<Handle<ClientHandler>>,
}

pub async fn connect_profile(profile: &Profile, vault: &Vault) -> Result<ConnectedSsh> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(900)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        window_size: 2 * 1024 * 1024,
        maximum_packet_size: 32768,
        ..Default::default()
    });

    let mut intermediates: Vec<Handle<ClientHandler>> = Vec::new();
    let mut handle: Handle<ClientHandler>;

    if let Some(first) = profile.jump.first() {
        handle = ssh_timeout(
            "连接跳板机",
            client::connect(
                config.clone(),
                (first.target.host.clone(), first.target.port),
                ClientHandler::new(&first.target.host),
            ),
        )
        .await?;
        auth_with_timeout(&mut handle, &first.target, &first.auth, vault).await?;

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
            let mut next = ssh_timeout(
                "通过跳板建立连接",
                client::connect_stream(
                    config.clone(),
                    channel.into_stream(),
                    ClientHandler::new(&hop.target.host),
                ),
            )
            .await?;
            auth_with_timeout(&mut next, &hop.target, &hop.auth, vault).await?;
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
        let mut next = ssh_timeout(
            "通过跳板连接目标主机",
            client::connect_stream(
                config.clone(),
                channel.into_stream(),
                ClientHandler::new(&profile.target.host),
            ),
        )
        .await?;
        auth_with_timeout(&mut next, &profile.target, &profile.auth, vault).await?;
        intermediates.push(handle);
        handle = next;
    } else {
        handle = ssh_timeout(
            "建立 SSH 连接",
            client::connect(
                config.clone(),
                (profile.target.host.clone(), profile.target.port),
                ClientHandler::new(&profile.target.host),
            ),
        )
        .await?;
        auth_with_timeout(&mut handle, &profile.target, &profile.auth, vault).await?;
    }

    Ok(ConnectedSsh {
        handle,
        _intermediates: intermediates,
    })
}

async fn auth_with_timeout(
    handle: &mut Handle<ClientHandler>,
    target: &Target,
    auth: &AuthRef,
    vault: &Vault,
) -> Result<()> {
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(handle, target, auth, vault))
        .await
        .map_err(|_| anyhow!("认证超时（{}s）", AUTH_TIMEOUT.as_secs()))?
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    target: &Target,
    auth: &AuthRef,
    vault: &Vault,
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
