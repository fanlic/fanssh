use russh::{client::Msg, Channel, ChannelMsg, Disconnect};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel as TauriChannel;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, MissedTickBehavior};

use crate::ipc::dto::{SessionState, TermEvent};
use crate::ipc::error::{AppError, AppResult};
use crate::session::model::{Profile, SessionId};
use crate::transport::ssh::{connect_profile, ConnectedSsh};
use crate::vault::Vault;

enum TermInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Clone, Default)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<SessionId, mpsc::Sender<TermInput>>>>,
}

impl SshManager {
    pub async fn open(
        &self,
        profile: Profile,
        vault: Arc<Vault>,
        on_event: TauriChannel<TermEvent>,
    ) -> AppResult<SessionId> {
        let session_id = SessionId::new();
        let _ = on_event.send(TermEvent::State {
            state: SessionState::Connecting,
        });
        let _ = on_event.send(TermEvent::State {
            state: SessionState::Authenticating,
        });

        let connected = connect_profile(&profile, &vault).await?;
        let mut channel = connected
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::new("ssh.channel_failed", e.to_string()))?;
        channel
            .request_pty(true, "xterm-256color", 120, 32, 0, 0, &[])
            .await
            .map_err(|e| AppError::new("ssh.pty_failed", e.to_string()))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::new("ssh.shell_failed", e.to_string()))?;

        let (tx, rx) = mpsc::channel::<TermInput>(256);
        self.sessions.lock().await.insert(session_id, tx);

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Ready,
        });
        let _ = on_event.send(TermEvent::Title {
            title: profile.name.clone(),
        });

        let manager = self.clone();
        tokio::spawn(async move {
            run_session(manager, session_id, connected, channel, rx, on_event).await;
        });

        Ok(session_id)
    }

    pub async fn write(&self, session: SessionId, bytes: Vec<u8>) -> AppResult<()> {
        let sender = self.sender(session).await?;
        sender
            .send(TermInput::Data(bytes))
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
    mut connected: ConnectedSsh,
    mut channel: Channel<Msg>,
    mut rx: mpsc::Receiver<TermInput>,
    on_event: TauriChannel<TermEvent>,
) {
    let mut decoder = Utf8Decoder::default();
    let mut buffer = String::new();
    let mut seq = 0u64;
    let mut exit_code: Option<i32> = None;
    let mut reason = "连接已关闭".to_string();

    let mut ticker = interval(Duration::from_millis(16));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

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
            _ = ticker.tick() => {
                flush(&mut buffer, &mut seq, &on_event);
            }
        }
    }

    flush(&mut buffer, &mut seq, &on_event);
    let _ = channel.eof().await;
    let _ = connected
        .handle
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    manager.sessions.lock().await.remove(&session_id);
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
