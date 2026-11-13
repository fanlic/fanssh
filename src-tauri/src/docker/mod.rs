//! Docker 管理：通过 SSH 的 `direct-streamlocal@openssh.com` 转发远端
//! `/var/run/docker.sock`，在 Rust 端直接发 HTTP/1.1 请求。
//!
//! 不在远端执行任何 shell 命令，容器 id 只作为 URL 路径的一段并经过十六进制
//! 白名单校验，避免路径注入。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ipc::error::{AppError, AppResult};
use crate::session::manager::SshManager;
use crate::session::model::SessionId;

const DOCKER_SOCKET: &str = "/var/run/docker.sock";
const MAX_RESPONSE: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DockerLogChunk {
    /// stdout | stderr
    pub stream: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DockerLogs {
    pub chunks: Vec<DockerLogChunk>,
    pub truncated: bool,
}

#[derive(Deserialize)]
struct ApiContainer {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Names", default)]
    names: Vec<String>,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: Vec<ApiPort>,
}

#[derive(Deserialize)]
struct ApiPort {
    #[serde(rename = "PrivatePort")]
    private_port: u16,
    #[serde(rename = "PublicPort")]
    public_port: Option<u16>,
    #[serde(rename = "Type", default)]
    kind: String,
    #[serde(rename = "IP", default)]
    ip: Option<String>,
}

/// 列出全部容器（含已停止）。
pub async fn containers(
    ssh: &SshManager,
    session: SessionId,
) -> AppResult<Vec<DockerContainer>> {
    let body = request(ssh, session, "/containers/json?all=1").await?;
    let raw: Vec<ApiContainer> = serde_json::from_slice(&body)
        .map_err(|err| AppError::new("docker.bad_response", format!("解析容器列表失败：{err}")))?;
    Ok(raw
        .into_iter()
        .map(|item| DockerContainer {
            id: item.id,
            name: item
                .names
                .first()
                .map(|name| name.trim_start_matches('/').to_string())
                .unwrap_or_default(),
            image: item.image,
            state: item.state,
            status: item.status,
            ports: format_ports(&item.ports),
        })
        .collect())
}

/// 读取容器最近 `tail` 行日志，按 Docker 多路复用帧拆分 stdout/stderr。
pub async fn logs(
    ssh: &SshManager,
    session: SessionId,
    container: &str,
    tail: u32,
) -> AppResult<DockerLogs> {
    let id = checked_container_id(container)?;
    let tail = tail.clamp(1, 5000);
    let path = format!(
        "/containers/{id}/logs?stdout=1&stderr=1&tail={tail}&timestamps=0"
    );
    let body = request(ssh, session, &path).await?;
    Ok(demux(&body))
}

fn format_ports(ports: &[ApiPort]) -> String {
    ports
        .iter()
        .map(|port| match port.public_port {
            Some(public) => {
                let ip = port.ip.as_deref().unwrap_or("0.0.0.0");
                format!("{ip}:{public}->{}/{}", port.private_port, port.kind)
            }
            None => format!("{}/{}", port.private_port, port.kind),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// 容器 id 只允许十六进制（12–64 位），并直接作为 URL 路径段使用。
fn checked_container_id(container: &str) -> AppResult<&str> {
    let ok = (12..=64).contains(&container.len()) && container.chars().all(|ch| ch.is_ascii_hexdigit());
    if ok {
        Ok(container)
    } else {
        Err(AppError::new("docker.bad_container", "容器标识不合法"))
    }
}

/// 在现有 SSH 连接上打开 docker.sock 通道并完成一次 HTTP 请求。
async fn request(ssh: &SshManager, session: SessionId, path: &str) -> AppResult<Vec<u8>> {
    let handle = ssh.handle(session).await?;
    let channel = handle
        .channel_open_direct_streamlocal(DOCKER_SOCKET)
        .await
        .map_err(|err| classify_socket(&err.to_string()))?;
    let mut stream = channel.into_stream();

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: docker\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    run_with_timeout(async {
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|err| classify_socket(&err.to_string()))?;
        stream
            .shutdown()
            .await
            .map_err(|err| classify_socket(&err.to_string()))?;

        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|err| classify_socket(&err.to_string()))?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.len() > MAX_RESPONSE {
                break;
            }
        }
        parse_http(&buffer)
    })
    .await
}

async fn run_with_timeout<F, T>(future: F) -> AppResult<T>
where
    F: std::future::Future<Output = AppResult<T>>,
{
    tokio::time::timeout(REQUEST_TIMEOUT, future)
        .await
        .map_err(|_| AppError::new("docker.timeout", "连接 Docker socket 超时"))?
}

fn parse_http(buffer: &[u8]) -> AppResult<Vec<u8>> {
    let Some(end) = find_header_end(buffer) else {
        return Err(AppError::new(
            "docker.daemon",
            "Docker 守护进程没有返回有效响应：请确认 Docker 正在运行，或 socket 路径不是默认的 /var/run/docker.sock",
        ));
    };
    let head = String::from_utf8_lossy(&buffer[..end]);
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let mut chunked = false;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }
    let raw_body = &buffer[end + 4..];
    let body = if chunked {
        decode_chunked(raw_body)?
    } else {
        raw_body.to_vec()
    };

    if (200..300).contains(&status) {
        return Ok(body);
    }
    let detail = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("message").and_then(|item| item.as_str()).map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(&body).trim().to_string());
    let lower = detail.to_ascii_lowercase();
    let (code, message) = match status {
        403 => (
            "docker.permission",
            "无权访问 Docker：当前用户可能不在 docker 组（socket 权限不足）".to_string(),
        ),
        404 => (
            "docker.not_found",
            "容器不存在或已被删除，请刷新容器列表".to_string(),
        ),
        _ if lower.contains("permission denied") => (
            "docker.permission",
            "无权访问 Docker：当前用户可能不在 docker 组（socket 权限不足）".to_string(),
        ),
        _ => (
            "docker.daemon",
            if detail.is_empty() {
                format!("Docker 请求失败（HTTP {status}）")
            } else {
                format!("Docker 请求失败（HTTP {status}）：{detail}")
            },
        ),
    };
    Err(AppError::new(code, message))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn decode_chunked(mut body: &[u8]) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let line = String::from_utf8_lossy(&body[..line_end]);
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| AppError::new("docker.bad_response", "Docker 响应分块格式错误"))?;
        body = &body[line_end + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size {
            out.extend_from_slice(body);
            break;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size..];
        if body.starts_with(b"\r\n") {
            body = &body[2..];
        }
        if out.len() > MAX_RESPONSE {
            break;
        }
    }
    Ok(out)
}

/// Docker 日志：TTY=false 时是 8 字节帧头（类型 1/2 + 3 字节保留 + 4 字节长度），
/// TTY=true 时是原始文本。这里用帧头合法性做启发式判断。
fn demux(body: &[u8]) -> DockerLogs {
    let mut chunks: Vec<DockerLogChunk> = Vec::new();
    let mut cursor = 0;
    let mut framed = !body.is_empty();
    let mut total = 0usize;

    while cursor < body.len() {
        if cursor + 8 > body.len() {
            framed = false;
            break;
        }
        let stream = body[cursor];
        let reserved = &body[cursor + 1..cursor + 4];
        let size = u32::from_be_bytes([
            body[cursor + 4],
            body[cursor + 5],
            body[cursor + 6],
            body[cursor + 7],
        ]) as usize;
        let valid = stream <= 2
            && reserved.iter().all(|byte| *byte == 0)
            && cursor + 8 + size <= body.len();
        if !valid {
            framed = false;
            break;
        }
        if stream == 1 || stream == 2 {
            let text = String::from_utf8_lossy(&body[cursor + 8..cursor + 8 + size]).to_string();
            total += text.len();
            chunks.push(DockerLogChunk {
                stream: if stream == 1 { "stdout" } else { "stderr" }.to_string(),
                text,
            });
        }
        cursor += 8 + size;
    }

    if !framed || chunks.is_empty() {
        return DockerLogs {
            chunks: vec![DockerLogChunk {
                stream: "stdout".to_string(),
                text: String::from_utf8_lossy(body).to_string(),
            }],
            truncated: false,
        };
    }
    DockerLogs {
        chunks,
        truncated: total > MAX_RESPONSE,
    }
}

fn classify_socket(message: &str) -> AppError {
    let lower = message.to_ascii_lowercase();
    if lower.contains("no such file") || lower.contains("not found") {
        return AppError::new(
            "docker.socket_missing",
            "Docker socket 不存在（/var/run/docker.sock）：远端可能未安装 Docker",
        );
    }
    if lower.contains("permission denied") {
        return AppError::new(
            "docker.permission",
            "无权访问 Docker socket：当前用户可能不在 docker 组",
        );
    }
    AppError::new(
        "docker.socket_failed",
        "无法连接 Docker socket：请确认 Docker 正在运行，且远程登录用户有访问 /var/run/docker.sock 的权限",
    )
}
