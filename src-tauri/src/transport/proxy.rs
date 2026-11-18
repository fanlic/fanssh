use anyhow::{anyhow, bail, Context, Result};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::session::model::SshPrefs;

/// 建立到目标主机的 TCP 连接；配置了代理时先完成 SOCKS5 / HTTP CONNECT 握手。
/// 返回的 TcpStream 已处于可承载 SSH 字节流的状态。
pub async fn tcp_connect(
    host: &str,
    port: u16,
    prefs: &SshPrefs,
    timeout: Duration,
) -> Result<TcpStream> {
    let proxy = if prefs.proxy_disabled {
        None
    } else {
        prefs
            .proxy
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    match proxy {
        Some(raw) => {
            let parsed = ProxyUrl::parse(raw)?;
            let mut stream = tokio::time::timeout(
                timeout,
                TcpStream::connect((parsed.host.as_str(), parsed.port)),
            )
            .await
            .map_err(|_| anyhow!("连接代理 {}:{} 超时", parsed.host, parsed.port))?
            .with_context(|| format!("连接代理 {}:{} 失败", parsed.host, parsed.port))?;
            if parsed.socks5 {
                socks5_connect(&mut stream, host, port, parsed.auth.as_ref()).await?;
            } else {
                http_connect(&mut stream, host, port, parsed.auth.as_ref()).await?;
            }
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
        None => {
            let stream = tokio::time::timeout(timeout, TcpStream::connect((host, port)))
                .await
                .map_err(|_| anyhow!("连接 {host}:{port} 超时"))?
                .with_context(|| format!("连接 {host}:{port} 失败"))?;
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
    }
}

struct ProxyUrl {
    socks5: bool,
    host: String,
    port: u16,
    auth: Option<(String, String)>,
}

impl ProxyUrl {
    fn parse(raw: &str) -> Result<Self> {
        let (scheme, rest) = raw.split_once("://").ok_or_else(|| {
            anyhow!("代理地址格式不正确，应为 socks5://host:port 或 http://host:port")
        })?;
        let socks5 = match scheme.to_ascii_lowercase().as_str() {
            "socks5" | "socks5h" => true,
            "http" => false,
            other => bail!("不支持的代理协议：{other}"),
        };
        let (auth, host_port) = match rest.rsplit_once('@') {
            Some((userinfo, host_port)) => {
                let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
                (Some((user.to_string(), pass.to_string())), host_port)
            }
            None => (None, rest),
        };
        let (host, port) = host_port
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("代理地址缺少端口"))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() {
            bail!("代理地址缺少主机名");
        }
        let port: u16 = port.parse().context("代理端口不合法")?;
        Ok(Self {
            socks5,
            host: host.to_string(),
            port,
            auth,
        })
    }
}

async fn socks5_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    auth: Option<&(String, String)>,
) -> Result<()> {
    let mut greeting = vec![0x05];
    if auth.is_some() {
        greeting.extend_from_slice(&[0x02, 0x00, 0x02]);
    } else {
        greeting.extend_from_slice(&[0x01, 0x00]);
    }
    stream.write_all(&greeting).await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    if reply[0] != 0x05 {
        bail!("代理返回了无效的 SOCKS 版本");
    }
    match reply[1] {
        0x00 => {}
        0x02 => {
            let (user, pass) = auth.ok_or_else(|| anyhow!("代理要求用户名密码认证"))?;
            if user.len() > 255 || pass.len() > 255 {
                bail!("代理用户名或密码过长");
            }
            let mut packet = vec![0x01, user.len() as u8];
            packet.extend_from_slice(user.as_bytes());
            packet.push(pass.len() as u8);
            packet.extend_from_slice(pass.as_bytes());
            stream.write_all(&packet).await?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await?;
            if status[1] != 0x00 {
                bail!("代理用户名或密码认证失败");
            }
        }
        0xff => bail!("代理不接受可用的认证方式"),
        method => bail!("代理要求不支持的认证方式：{method}"),
    }

    let mut request = vec![0x05, 0x01, 0x00];
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        request.push(0x01);
        request.extend_from_slice(&ip.octets());
    } else if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        request.push(0x04);
        request.extend_from_slice(&ip.octets());
    } else {
        if host.len() > 255 {
            bail!("目标主机名过长");
        }
        request.push(0x03);
        request.push(host.len() as u8);
        request.extend_from_slice(host.as_bytes());
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        bail!("代理返回了无效的 SOCKS 响应");
    }
    if head[1] != 0x00 {
        bail!("SOCKS5 代理连接失败（错误码 {}）", head[1]);
    }
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 6];
            stream.read_exact(&mut skip).await?;
        }
        0x04 => {
            let mut skip = [0u8; 18];
            stream.read_exact(&mut skip).await?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut skip).await?;
        }
        atyp => bail!("SOCKS5 代理返回未知地址类型：{atyp}"),
    }
    Ok(())
}

async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    auth: Option<&(String, String)>,
) -> Result<()> {
    use base64::Engine;
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if let Some((user, pass)) = auth {
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        request.push_str(&format!("Proxy-Authorization: Basic {encoded}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            bail!("代理在 CONNECT 握手期间关闭了连接");
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 16 * 1024 {
            bail!("代理 CONNECT 响应过长");
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let status = text.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        bail!("HTTP 代理拒绝连接：{status}");
    }
    Ok(())
}
