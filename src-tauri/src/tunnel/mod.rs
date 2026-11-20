use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify};
use uuid::Uuid;

use crate::ipc::dto::{TunnelEvent, TunnelState};
use crate::ipc::error::{AppError, AppResult};
use crate::known_hosts::KnownHosts;
use crate::session::model::{AuthRef, Profile, Protocol, TunnelKind, TunnelRoute};
use crate::transport::ssh::connect_profile_with_forward;
use crate::vault::Vault;

/// 意外断开后重连的等待时间。
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// 端口转发管理器。一条路由对应一个后台任务，连接复用绑定的 SSH 服务器配置。
#[derive(Clone, Default)]
pub struct TunnelManager {
    routes: Arc<Mutex<HashMap<Uuid, Arc<Notify>>>>,
}

impl TunnelManager {
    pub async fn start(
        &self,
        profile: &Profile,
        server: Profile,
        vault: Arc<Vault>,
        known_hosts: Arc<KnownHosts>,
        route: TunnelRoute,
        on_event: TauriChannel<TunnelEvent>,
    ) -> AppResult<()> {
        if server.protocol != Protocol::Ssh {
            return Err(AppError::new(
                "tunnel.server_invalid",
                "隧道只能绑定 SSH 服务器配置",
            ));
        }
        if matches!(server.auth, AuthRef::KeyboardInteractive) {
            return Err(AppError::new(
                "tunnel.auth_unsupported",
                "隧道暂不支持键盘交互认证，请把服务器认证方式改为密码或密钥",
            ));
        }

        let mut routes = self.routes.lock().await;
        if routes.contains_key(&route.id) {
            return Err(AppError::new(
                "tunnel.already_running",
                "该转发路由已在运行",
            ));
        }
        let stop = Arc::new(Notify::new());
        routes.insert(route.id, stop.clone());
        drop(routes);

        let manager = self.clone();
        let auto_reconnect = profile.tunnel_prefs().auto_reconnect;
        tokio::spawn(async move {
            run_route(
                manager,
                route,
                server,
                vault,
                known_hosts,
                on_event,
                stop,
                auto_reconnect,
            )
            .await;
        });
        Ok(())
    }

    pub async fn stop(&self, route_id: Uuid) -> AppResult<()> {
        let routes = self.routes.lock().await;
        let stop = routes
            .get(&route_id)
            .cloned()
            .ok_or_else(|| AppError::new("tunnel.not_running", "该转发路由未在运行"))?;
        stop.notify_one();
        Ok(())
    }

    pub async fn active(&self) -> Vec<Uuid> {
        self.routes.lock().await.keys().copied().collect()
    }
}

async fn run_route(
    manager: TunnelManager,
    route: TunnelRoute,
    server: Profile,
    vault: Arc<Vault>,
    known_hosts: Arc<KnownHosts>,
    on_event: TauriChannel<TunnelEvent>,
    stop: Arc<Notify>,
    auto_reconnect: bool,
) {
    loop {
        emit(&on_event, route.id, TunnelState::Starting, None, None);
        match run_once(&route, &server, &vault, &known_hosts, &on_event, &stop).await {
            Ok(()) => {
                emit(&on_event, route.id, TunnelState::Stopped, None, None);
                break;
            }
            Err(error) => {
                let message = format!("{error:#}");
                log::warn!("[tunnel] {} 失败: {message}", route.id);
                emit(
                    &on_event,
                    route.id,
                    TunnelState::Error,
                    None,
                    Some(message.clone()),
                );
                if !auto_reconnect {
                    emit(&on_event, route.id, TunnelState::Stopped, None, None);
                    break;
                }
                tokio::select! {
                    _ = stop.notified() => {
                        emit(&on_event, route.id, TunnelState::Stopped, None, None);
                        break;
                    }
                    _ = tokio::time::sleep(RECONNECT_DELAY) => {}
                }
            }
        }
    }
    manager.routes.lock().await.remove(&route.id);
}

async fn run_once(
    route: &TunnelRoute,
    server: &Profile,
    vault: &Vault,
    known_hosts: &Arc<KnownHosts>,
    on_event: &TauriChannel<TunnelEvent>,
    stop: &Arc<Notify>,
) -> Result<()> {
    if route.kind == TunnelKind::Remote {
        run_remote(route, server, vault, known_hosts, on_event, stop).await
    } else {
        run_listener(route, server, vault, known_hosts, on_event, stop).await
    }
}

/// 本地转发与动态代理都在本机监听，区别仅在每个连接的远端目标如何确定。
async fn run_listener(
    route: &TunnelRoute,
    server: &Profile,
    vault: &Vault,
    known_hosts: &Arc<KnownHosts>,
    on_event: &TauriChannel<TunnelEvent>,
    stop: &Arc<Notify>,
) -> Result<()> {
    let connected = connect_profile_with_forward(server, vault, known_hosts.clone(), None, None)
        .await
        .map_err(|error| anyhow!("连接 SSH 服务器失败：{error:#}"))?;
    let handle = connected.handle.clone();

    let bind_host = bind_host(&route.local_host);
    let listener = TcpListener::bind((bind_host.as_str(), route.local_port))
        .await
        .with_context(|| format!("监听 {bind_host}:{} 失败", route.local_port))?;
    let port = listener.local_addr()?.port();
    emit(on_event, route.id, TunnelState::Running, Some(port), None);

    loop {
        tokio::select! {
            _ = stop.notified() => break,
            accepted = listener.accept() => {
                let (mut stream, _) = accepted.context("接受本地连接失败")?;
                let handle = handle.clone();
                let route = route.clone();
                tokio::spawn(async move {
                    let target = match route.kind {
                        TunnelKind::Dynamic => match tokio::time::timeout(
                            SOCKS_HANDSHAKE_TIMEOUT,
                            socks5_handshake(&mut stream),
                        )
                        .await
                        {
                            Ok(Ok(target)) => target,
                            Ok(Err(error)) => {
                                log::warn!("[tunnel] SOCKS5 握手失败: {error:#}");
                                return;
                            }
                            Err(_) => {
                                log::warn!("[tunnel] SOCKS5 握手超时");
                                return;
                            }
                        },
                        _ => (route.remote_host.clone(), route.remote_port),
                    };
                    if let Err(error) = bridge(&handle, &mut stream, &target.0, target.1).await {
                        log::warn!("[tunnel] 转发 {}:{} 失败: {error:#}", target.0, target.1);
                    }
                });
            }
        }
    }

    let _ = connected
        .handle
        .disconnect(russh::Disconnect::ByApplication, "tunnel stopped", "en")
        .await;
    Ok(())
}

/// 远程转发：服务器监听端口，每条接入连接回连本机目标。
async fn run_remote(
    route: &TunnelRoute,
    server: &Profile,
    vault: &Vault,
    known_hosts: &Arc<KnownHosts>,
    on_event: &TauriChannel<TunnelEvent>,
    stop: &Arc<Notify>,
) -> Result<()> {
    let (forward_tx, mut forward_rx) = mpsc::unbounded_channel();
    let connected =
        connect_profile_with_forward(server, vault, known_hosts.clone(), None, Some(forward_tx))
            .await
            .map_err(|error| anyhow!("连接 SSH 服务器失败：{error:#}"))?;
    let handle = connected.handle.clone();

    let bind_host = bind_host(&route.local_host);
    let port = handle
        .tcpip_forward(bind_host.clone(), route.local_port as u32)
        .await
        .with_context(|| format!("服务器拒绝监听 {bind_host}:{}", route.local_port))?;
    emit(
        on_event,
        route.id,
        TunnelState::Running,
        Some(port as u16),
        None,
    );

    loop {
        tokio::select! {
            _ = stop.notified() => break,
            incoming = forward_rx.recv() => {
                let Some(channel) = incoming else {
                    bail!("SSH 连接已断开");
                };
                let target = (route.remote_host.clone(), route.remote_port);
                tokio::spawn(async move {
                    let mut remote = channel.into_stream();
                    match TcpStream::connect((target.0.as_str(), target.1)).await {
                        Ok(mut local) => {
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                        }
                        Err(error) => {
                            log::warn!("[tunnel] 回连本机 {}:{} 失败: {error}", target.0, target.1);
                        }
                    }
                });
            }
        }
    }

    let _ = handle.cancel_tcpip_forward(bind_host, port).await;
    let _ = connected
        .handle
        .disconnect(russh::Disconnect::ByApplication, "tunnel stopped", "en")
        .await;
    Ok(())
}

async fn bridge(
    handle: &Arc<russh::client::Handle<crate::transport::ssh::ClientHandler>>,
    stream: &mut TcpStream,
    host: &str,
    port: u16,
) -> Result<()> {
    let channel = handle
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
        .with_context(|| format!("打开到 {host}:{port} 的转发通道失败"))?;
    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(stream, &mut remote)
        .await
        .context("转发数据失败")?;
    Ok(())
}

/// 无认证 SOCKS5 服务端握手，返回客户端请求的目标地址。
async fn socks5_handshake(stream: &mut TcpStream) -> Result<(String, u16)> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        bail!("不是 SOCKS5 请求");
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0x00) {
        let _ = stream.write_all(&[0x05, 0xff]).await;
        bail!("客户端不支持无认证方式");
    }
    stream.write_all(&[0x05, 0x00]).await?;

    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    if request[0] != 0x05 || request[1] != 0x01 {
        let _ = stream
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await;
        bail!("仅支持 SOCKS5 CONNECT");
    }
    let host = match request[3] {
        0x01 => {
            let mut octets = [0u8; 4];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv4Addr::from(octets).to_string()
        }
        0x03 => {
            let mut length = [0u8; 1];
            stream.read_exact(&mut length).await?;
            let mut name = vec![0u8; length[0] as usize];
            stream.read_exact(&mut name).await?;
            String::from_utf8(name).context("SOCKS5 域名不是合法 UTF-8")?
        }
        0x04 => {
            let mut octets = [0u8; 16];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv6Addr::from(octets).to_string()
        }
        atyp => bail!("不支持的 SOCKS5 地址类型：{atyp}"),
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;

    stream
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await?;
    Ok((host, u16::from_be_bytes(port)))
}

fn bind_host(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        "127.0.0.1".to_string()
    } else {
        value.to_string()
    }
}

fn emit(
    on_event: &TauriChannel<TunnelEvent>,
    route_id: Uuid,
    state: TunnelState,
    port: Option<u16>,
    message: Option<String>,
) {
    let _ = on_event.send(TunnelEvent::State {
        route_id,
        state,
        port,
        message,
    });
}
