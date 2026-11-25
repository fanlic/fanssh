use russh::client::Handle;
use russh::{client::Msg, Channel, ChannelMsg, Disconnect};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, MissedTickBehavior};

use crate::ipc::dto::{SessionState, TermEvent};
use crate::ipc::error::{AppError, AppResult};
use crate::known_hosts::KnownHosts;
use crate::session::model::{Profile, SessionId, SshPrefs};
use crate::transport::ssh::{connect_profile, AuthPrompts, AuthUi, ClientHandler, ConnectedSsh};
use crate::vault::Vault;

enum TermInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// 一次性 exec 的输出（stdout/stderr/退出码）。
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

const MAX_CAPTURE: usize = 4 * 1024 * 1024;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Default)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<SessionId, mpsc::Sender<TermInput>>>>,
    /// 活跃 SSH 连接的句柄，供 Docker 等复用同一条连接开 exec 通道。
    handles: Arc<Mutex<HashMap<SessionId, Arc<Handle<ClientHandler>>>>>,
    /// 键盘交互认证的前端应答等待队列。
    pub(crate) auth_prompts: AuthPrompts,
    /// 每个会话的输出编码，用于把前端 UTF-8 输入转成目标字符集。
    encodings: Arc<Mutex<HashMap<SessionId, &'static encoding_rs::Encoding>>>,
}

impl SshManager {
    pub async fn open(
        &self,
        profile: Profile,
        vault: Arc<Vault>,
        known_hosts: Arc<KnownHosts>,
        on_event: TauriChannel<TermEvent>,
    ) -> AppResult<SessionId> {
        let session_id = SessionId::new();
        let _ = on_event.send(TermEvent::State {
            state: SessionState::Connecting,
        });
        let prefs = profile.ssh_prefs();
        let encoding = resolve_encoding(prefs.encoding.as_deref());
        let auth_ui = AuthUi {
            prompts: &self.auth_prompts,
            on_event: &on_event,
        };
        let connected = connect_profile(&profile, &vault, known_hosts, Some(auth_ui)).await?;
        let _ = on_event.send(TermEvent::State {
            state: SessionState::OpeningShell,
        });
        let channel = connected
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::new("ssh.channel_failed", e.to_string()))?;
        let term = prefs
            .terminal_type
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("xterm-256color");
        channel
            .request_pty(true, term, 120, 32, 0, 0, &[])
            .await
            .map_err(|e| AppError::new("ssh.pty_failed", e.to_string()))?;
        for item in &prefs.env {
            let key = item.key.trim();
            if key.is_empty() {
                continue;
            }
            // 部分服务端会拒绝 SetEnv，失败不阻断登录。
            let _ = channel.set_env(true, key, item.value.as_str()).await;
        }
        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::new("ssh.shell_failed", e.to_string()))?;

        let (tx, rx) = mpsc::channel::<TermInput>(256);
        self.sessions.lock().await.insert(session_id, tx);
        self.handles
            .lock()
            .await
            .insert(session_id, connected.handle.clone());
        self.encodings.lock().await.insert(session_id, encoding);

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Ready,
        });
        let _ = on_event.send(TermEvent::Title {
            title: profile.name.clone(),
        });

        let startup = startup_script(&prefs);
        let keepalive = keepalive_command(&prefs);
        let manager = self.clone();
        tokio::spawn(async move {
            run_session(
                manager,
                session_id,
                Some(connected),
                channel,
                rx,
                on_event,
                encoding,
                startup,
                keepalive,
            )
            .await;
        });

        Ok(session_id)
    }

    /// 把前端提交的键盘交互认证应答交回等待中的连接流程。
    pub async fn respond_auth(
        &self,
        prompt_id: uuid::Uuid,
        responses: Option<Vec<String>>,
    ) -> AppResult<()> {
        if self.auth_prompts.respond(prompt_id, responses).await {
            Ok(())
        } else {
            Err(AppError::new(
                "auth.prompt_expired",
                "认证提示已失效或已超时，请重新连接",
            ))
        }
    }

    /// 在当前 SSH 会话上开一个新通道执行命令，并作为独立终端会话返回。
    /// 连接本身复用原会话，不重新认证。
    pub async fn open_exec(
        &self,
        session: SessionId,
        command: String,
        title: String,
        on_event: TauriChannel<TermEvent>,
    ) -> AppResult<SessionId> {
        let handle = self.handle(session).await?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::new("ssh.channel_failed", e.to_string()))?;
        channel
            .request_pty(true, "xterm-256color", 120, 32, 0, 0, &[])
            .await
            .map_err(|e| AppError::new("ssh.pty_failed", e.to_string()))?;
        channel
            .exec(true, command.as_str())
            .await
            .map_err(|e| AppError::new("ssh.exec_failed", e.to_string()))?;

        let exec_id = SessionId::new();
        let (tx, rx) = mpsc::channel::<TermInput>(256);
        self.sessions.lock().await.insert(exec_id, tx);

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Ready,
        });
        let _ = on_event.send(TermEvent::Title { title });

        let manager = self.clone();
        tokio::spawn(async move {
            run_session(
                manager,
                exec_id,
                None,
                channel,
                rx,
                on_event,
                encoding_rs::UTF_8,
                None,
                None,
            )
            .await;
        });

        Ok(exec_id)
    }

    /// 在现有 SSH 连接上执行一次性命令并收集输出（Docker 管理使用）。
    pub async fn exec_capture(&self, session: SessionId, command: &str) -> AppResult<ExecOutput> {
        let handle = self.handle(session).await?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::new("ssh.channel_failed", e.to_string()))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| AppError::new("ssh.exec_failed", e.to_string()))?;

        let collect = async {
            let mut stdout: Vec<u8> = Vec::new();
            let mut stderr: Vec<u8> = Vec::new();
            let mut code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        if stdout.len() < MAX_CAPTURE {
                            stdout.extend_from_slice(&data);
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        if stderr.len() < MAX_CAPTURE {
                            stderr.extend_from_slice(&data);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        code = Some(exit_status as i32);
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
            ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).to_string(),
                stderr: String::from_utf8_lossy(&stderr).to_string(),
                code,
            }
        };

        tokio::time::timeout(CAPTURE_TIMEOUT, collect)
            .await
            .map_err(|_| AppError::new("ssh.exec_timeout", "远端命令执行超时"))
    }

    pub(crate) async fn handle(&self, session: SessionId) -> AppResult<Arc<Handle<ClientHandler>>> {
        self.handles
            .lock()
            .await
            .get(&session)
            .cloned()
            .ok_or_else(|| AppError::new("session.not_found", "SSH 会话不存在或已关闭"))
    }

    pub async fn write(&self, session: SessionId, bytes: Vec<u8>) -> AppResult<()> {
        let encoding = self
            .encodings
            .lock()
            .await
            .get(&session)
            .copied()
            .unwrap_or(encoding_rs::UTF_8);
        let payload = encode_input(&bytes, encoding);
        let sender = self.sender(session).await?;
        sender
            .send(TermInput::Data(payload))
            .await
            .map_err(|_| AppError::new("session.closed", "会话已关闭"))
    }

    pub async fn resize(&self, session: SessionId, cols: u16, rows: u16) -> AppResult<()> {
        let sender = self.sender(session).await?;
        sender
            .send(TermInput::Resize { cols, rows })
            .await
            .map_err(|_| AppError::new("session.closed", "会话已关闭"))
    }

    pub async fn close(&self, session: SessionId) -> AppResult<()> {
        let sender = self.sender(session).await?;
        sender
            .send(TermInput::Close)
            .await
            .map_err(|_| AppError::new("session.closed", "会话已关闭"))
    }

    async fn sender(&self, session: SessionId) -> AppResult<mpsc::Sender<TermInput>> {
        self.sessions
            .lock()
            .await
            .get(&session)
            .cloned()
            .ok_or_else(|| AppError::new("session.not_found", "会话不存在或已关闭"))
    }
}

async fn run_session(
    manager: SshManager,
    session_id: SessionId,
    connected: Option<ConnectedSsh>,
    mut channel: Channel<Msg>,
    mut rx: mpsc::Receiver<TermInput>,
    on_event: TauriChannel<TermEvent>,
    encoding: &'static encoding_rs::Encoding,
    startup: Option<String>,
    keepalive: Option<(String, Duration)>,
) {
    let mut decoder = EncodingDecoder::new(encoding);
    let mut buffer = String::new();
    let mut seq = 0u64;
    let mut exit_code: Option<i32> = None;
    let mut reason = "连接已关闭".to_string();

    let mut ticker = interval(Duration::from_millis(16));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    if let Some(script) = startup {
        if channel.data(script.as_bytes()).await.is_err() {
            reason = "发送初始化命令失败".to_string();
        }
    }

    let mut keepalive_ticker = keepalive.as_ref().map(|(_, period)| {
        let mut ticker = interval(*period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        ticker
    });
    if let Some(ticker) = keepalive_ticker.as_mut() {
        // interval 的第一次 tick 会立即完成，先消费掉。
        ticker.tick().await;
    }

    loop {
        tokio::select! {
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if let Some(text) = decoder.push(&data) {
                            buffer.push_str(&text);
                            if buffer.len() >= 32 * 1024 {
                                flush(&mut buffer, &mut seq, &on_event);
                            }
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            command = rx.recv() => {
                match command {
                    Some(TermInput::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            reason = "写入远端失败".to_string();
                            break;
                        }
                    }
                    Some(TermInput::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                    Some(TermInput::Close) => {
                        let _ = channel.eof().await;
                        reason = "用户关闭会话".to_string();
                        break;
                    }
                    None => break,
                }
            }
            _ = async {
                match keepalive_ticker.as_mut() {
                    Some(ticker) => { ticker.tick().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {
                if let Some((command, _)) = keepalive.as_ref() {
                    let _ = channel.data(format!("{command}\r").as_bytes()).await;
                }
            }
            _ = ticker.tick() => {
                flush(&mut buffer, &mut seq, &on_event);
            }
        }
    }

    if let Some(text) = decoder.finish() {
        buffer.push_str(&text);
    }
    flush(&mut buffer, &mut seq, &on_event);
    let _ = channel.eof().await;
    // 只有独立打开的会话才断开连接；复用父连接的 exec 会话不能断开整条 SSH。
    if let Some(connected) = connected {
        let _ = connected
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        manager.handles.lock().await.remove(&session_id);
    }
    manager.sessions.lock().await.remove(&session_id);
    manager.encodings.lock().await.remove(&session_id);
    let _ = on_event.send(TermEvent::Exit {
        code: exit_code,
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

fn resolve_encoding(label: Option<&str>) -> &'static encoding_rs::Encoding {
    label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| encoding_rs::Encoding::for_label(value.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8)
}

/// 前端 xterm 始终发送 UTF-8，按会话编码转换成目标字符集后再写入 SSH。
fn encode_input(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> Vec<u8> {
    if std::ptr::eq(encoding, encoding_rs::UTF_8) {
        return bytes.to_vec();
    }
    let text = String::from_utf8_lossy(bytes);
    let (encoded, _, _) = encoding.encode(&text);
    encoded.into_owned()
}

fn startup_script(prefs: &SshPrefs) -> Option<String> {
    let mut lines = Vec::new();
    if let Some(path) = prefs
        .default_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("cd {}", shell_quote(path)));
    }
    if let Some(command) = prefs
        .init_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(command.to_string());
    }
    if lines.is_empty() {
        None
    } else {
        Some(format!("{}\r", lines.join("\r")))
    }
}

fn keepalive_command(prefs: &SshPrefs) -> Option<(String, Duration)> {
    prefs
        .keepalive_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|command| {
            (
                command.to_string(),
                Duration::from_millis(prefs.keepalive_command_ms.max(1000)),
            )
        })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 按会话编码增量解码远端输出。
pub(crate) struct EncodingDecoder {
    decoder: encoding_rs::Decoder,
}

impl EncodingDecoder {
    pub(crate) fn new(encoding: &'static encoding_rs::Encoding) -> Self {
        Self {
            decoder: encoding.new_decoder_without_bom_handling(),
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) -> Option<String> {
        let capacity = self.decoder.max_utf8_buffer_length(chunk.len())?;
        let mut out = String::with_capacity(capacity);
        let (result, _, _) = self.decoder.decode_to_string(chunk, &mut out, false);
        debug_assert_eq!(result, encoding_rs::CoderResult::InputEmpty);
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    pub(crate) fn finish(&mut self) -> Option<String> {
        let capacity = self.decoder.max_utf8_buffer_length(0)?;
        let mut out = String::with_capacity(capacity);
        let _ = self.decoder.decode_to_string(&[], &mut out, true);
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
}

/// 增量 UTF-8 解码：避免多字节字符被 SSH / 串口分片切断时出现乱码。
#[derive(Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Option<String> {
        if chunk.is_empty() {
            return None;
        }
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        out.push_str(
                            std::str::from_utf8(&self.pending[..valid]).unwrap_or_default(),
                        );
                    }
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                    }
                }
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::EncodingDecoder;

    #[test]
    fn ssh_output_decodes_across_packet_boundaries() {
        let mut decoder = EncodingDecoder::new(encoding_rs::UTF_8);
        assert_eq!(decoder.push(b"prompt$ ").as_deref(), Some("prompt$ "));

        let bytes = "中".as_bytes();
        assert_eq!(decoder.push(&bytes[..1]), None);
        assert_eq!(decoder.push(&bytes[1..]).as_deref(), Some("中"));

        assert_eq!(decoder.push(&bytes[..1]), None);
        assert_eq!(decoder.finish().as_deref(), Some("�"));
    }
}
