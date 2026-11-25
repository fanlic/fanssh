use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

use crate::ipc::dto::{SessionState, TermEvent};
use crate::ipc::error::{AppError, AppResult};
use crate::session::manager::Utf8Decoder;
use crate::session::model::{AuthRef, Profile, SessionId};
use crate::vault::Vault;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 自动填登录信息时只回看最近一段输出，避免把历史行误判成提示符。
const PROMPT_TAIL: usize = 200;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;

enum TelnetInput {
    Write(Vec<u8>),
    Close,
}

/// Telnet 会话管理器。明文协议只负责原始字节收发与最小 IAC 协商，
/// 输出仍走 `TermEvent`，前端与 SSH 共用同一套终端渲染。
#[derive(Clone, Default)]
pub struct TelnetManager {
    sessions: Arc<Mutex<HashMap<SessionId, mpsc::Sender<TelnetInput>>>>,
}

impl TelnetManager {
    pub async fn open(
        &self,
        profile: Profile,
        vault: Arc<Vault>,
        on_event: TauriChannel<TermEvent>,
    ) -> AppResult<SessionId> {
        let host = profile.target.host.trim().to_string();
        if host.is_empty() {
            return Err(AppError::new("telnet.invalid_host", "Telnet 地址不能为空"));
        }
        if profile.target.port == 0 {
            return Err(AppError::new("telnet.invalid_port", "Telnet 端口不合法"));
        }

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Connecting,
        });

        let stream = tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((host.as_str(), profile.target.port)),
        )
        .await
        .map_err(|_| AppError::new("telnet.timeout", "连接 Telnet 服务器超时"))?
        .map_err(|e| {
            AppError::new(
                "telnet.connect_failed",
                format!("连接 {}:{} 失败：{e}", host, profile.target.port),
            )
        })?;
        let _ = stream.set_nodelay(true);

        let user = profile.target.user.trim().to_string();
        let password = match &profile.auth {
            AuthRef::Password { secret } => vault
                .get(secret)
                .ok()
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty()),
            _ => None,
        };

        let session_id = SessionId::new();
        let (tx, rx) = mpsc::channel::<TelnetInput>(256);
        self.sessions.lock().await.insert(session_id, tx);

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Ready,
        });
        let _ = on_event.send(TermEvent::Title {
            title: profile.name.clone(),
        });

        let manager = self.clone();
        tokio::spawn(async move {
            run_session(manager, session_id, stream, rx, on_event, user, password).await;
        });

        Ok(session_id)
    }

    pub async fn write(&self, session: SessionId, bytes: Vec<u8>) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.sender(session)
            .await?
            .send(TelnetInput::Write(bytes))
            .await
            .map_err(|_| AppError::new("session.closed", "Telnet 会话已关闭"))
    }

    pub async fn close(&self, session: SessionId) -> AppResult<()> {
        self.sender(session)
            .await?
            .send(TelnetInput::Close)
            .await
            .map_err(|_| AppError::new("session.closed", "Telnet 会话已关闭"))
    }

    async fn sender(&self, session: SessionId) -> AppResult<mpsc::Sender<TelnetInput>> {
        self.sessions
            .lock()
            .await
            .get(&session)
            .cloned()
            .ok_or_else(|| AppError::new("session.not_found", "Telnet 会话不存在或已关闭"))
    }
}

async fn run_session(
    manager: TelnetManager,
    session_id: SessionId,
    stream: TcpStream,
    mut rx: mpsc::Receiver<TelnetInput>,
    on_event: TauriChannel<TermEvent>,
    user: String,
    password: Option<String>,
) {
    let (mut reader, mut writer) = stream.into_split();
    let mut parser = TelnetParser::default();
    let mut decoder = Utf8Decoder::default();
    let mut tail = String::new();
    let mut user_sent = user.is_empty();
    let mut password_sent = password.is_none();
    let mut reason = "连接已关闭".to_string();
    let mut buffer = String::new();
    let mut seq = 0u64;
    let mut read_buffer = [0u8; 8192];

    loop {
        tokio::select! {
            result = reader.read(&mut read_buffer) => {
                match result {
                    Ok(0) => {
                        reason = "服务器关闭了连接".to_string();
                        break;
                    }
                    Err(error) => {
                        reason = format!("读取 Telnet 数据失败：{error}");
                        break;
                    }
                    Ok(read) => {
                        let (payload, replies) = parser.feed(&read_buffer[..read]);
                        if !replies.is_empty() && writer.write_all(&replies).await.is_err() {
                            reason = "写入 Telnet 协商数据失败".to_string();
                            break;
                        }
                        if let Some(text) = decoder.push(&payload) {
                            tail.push_str(&text);
                            if tail.len() > PROMPT_TAIL {
                                let cut = tail.len() - PROMPT_TAIL;
                                let boundary = tail
                                    .char_indices()
                                    .map(|(index, _)| index)
                                    .find(|index| *index >= cut)
                                    .unwrap_or(tail.len());
                                tail.drain(..boundary);
                            }
                            buffer.push_str(&text);
                            // 明文会话没有独立的渲染 tick，收到数据就立即下发。
                            flush(&mut buffer, &mut seq, &on_event);
                            // 明文协议的登录信息：只在出现提示符时各发送一次。
                            if !user_sent && prompt_matches(&tail, USER_PROMPTS) {
                                user_sent = true;
                                if writer
                                    .write_all(&encode_payload(format!("{user}\r").as_bytes()))
                                    .await
                                    .is_err()
                                {
                                    reason = "写入 Telnet 数据失败".to_string();
                                    break;
                                }
                            }
                            if let Some(password) = password.as_deref() {
                                if !password_sent && prompt_matches(&tail, PASSWORD_PROMPTS) {
                                    password_sent = true;
                                    if writer
                                        .write_all(&encode_payload(format!("{password}\r").as_bytes()))
                                        .await
                                        .is_err()
                                    {
                                        reason = "写入 Telnet 数据失败".to_string();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            command = rx.recv() => {
                match command {
                    Some(TelnetInput::Write(bytes)) => {
                        if writer.write_all(&encode_payload(&bytes)).await.is_err() {
                            reason = "写入 Telnet 数据失败".to_string();
                            break;
                        }
                    }
                    Some(TelnetInput::Close) => {
                        reason = "用户关闭会话".to_string();
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    flush(&mut buffer, &mut seq, &on_event);
    let _ = writer.shutdown().await;
    manager.sessions.lock().await.remove(&session_id);
    let _ = on_event.send(TermEvent::Exit {
        code: None,
        reason: Some(reason),
    });
}

fn flush(buffer: &mut String, seq: &mut u64, on_event: &TauriChannel<TermEvent>) {
    if buffer.is_empty() {
        return;
    }
    *seq += 1;
    let _ = on_event.send(TermEvent::Data {
        seq: *seq,
        text: std::mem::take(buffer),
    });
}

const USER_PROMPTS: &[&str] = &[
    "login:",
    "login：",
    "username:",
    "username：",
    "user name:",
    "user name：",
    "用户名:",
    "用户名：",
    "账号:",
    "账号：",
];
const PASSWORD_PROMPTS: &[&str] = &[
    "password:",
    "password：",
    "passwd:",
    "passwd：",
    "密码:",
    "密码：",
];

/// 提示符通常以冒号结尾，末尾可能有空格或控制字符。
fn prompt_matches(tail: &str, needles: &[&str]) -> bool {
    let cleaned: String = tail
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\n')
        .collect::<String>()
        .to_lowercase();
    let trimmed = cleaned.trim_end();
    needles.iter().any(|needle| trimmed.ends_with(needle))
}

/// Telnet NVT：CR 需要跟 LF，数据里的 0xFF 需要转义。
fn encode_payload(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 8);
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            IAC => out.extend_from_slice(&[IAC, IAC]),
            b'\r' => {
                out.extend_from_slice(b"\r\n");
                if bytes.get(index + 1) == Some(&b'\n') {
                    index += 1;
                }
            }
            value => out.push(value),
        }
        index += 1;
    }
    out
}

#[derive(Default)]
struct TelnetParser {
    state: ParseState,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    #[default]
    Data,
    Iac,
    Negotiation(u8),
    Sub,
    SubIac,
}

impl TelnetParser {
    /// 返回（可显示的原始数据，需要回写的协商应答）。
    fn feed(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(chunk.len());
        let mut replies = Vec::new();
        for byte in chunk {
            let byte = *byte;
            match self.state {
                ParseState::Data => {
                    if byte == IAC {
                        self.state = ParseState::Iac;
                    } else {
                        data.push(byte);
                    }
                }
                ParseState::Iac => match byte {
                    IAC => {
                        data.push(IAC);
                        self.state = ParseState::Data;
                    }
                    WILL | WONT | DO | DONT => {
                        self.state = ParseState::Negotiation(byte);
                    }
                    SB => self.state = ParseState::Sub,
                    _ => self.state = ParseState::Data,
                },
                ParseState::Negotiation(command) => {
                    self.negotiate(command, byte, &mut replies);
                    self.state = ParseState::Data;
                }
                ParseState::Sub => {
                    if byte == IAC {
                        self.state = ParseState::SubIac;
                    }
                }
                ParseState::SubIac => {
                    self.state = if byte == SE {
                        ParseState::Data
                    } else {
                        ParseState::Sub
                    };
                }
            }
        }
        (data, replies)
    }

    fn negotiate(&mut self, command: u8, option: u8, replies: &mut Vec<u8>) {
        match command {
            WILL => {
                // 服务端声明会回显/抑制 GA 时接受，其余一律拒绝。
                if option == OPT_ECHO || option == OPT_SGA {
                    replies.extend_from_slice(&[IAC, DO, option]);
                } else {
                    replies.extend_from_slice(&[IAC, DONT, option]);
                }
            }
            DO => {
                if option == OPT_SGA {
                    replies.extend_from_slice(&[IAC, WILL, option]);
                } else {
                    replies.extend_from_slice(&[IAC, WONT, option]);
                }
            }
            WONT | DONT => {}
            _ => {}
        }
    }
}
