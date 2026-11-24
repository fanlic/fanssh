use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Deserialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;

use crate::ipc::dto::{SessionState, TermEvent};
use crate::session::manager::EncodingDecoder;
use crate::session::model::SessionId;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalShell {
    System,
    PowerShell,
    Cmd,
}

impl LocalShell {
    fn command(self) -> Result<CommandBuilder> {
        let mut command = match self {
            Self::System if !cfg!(windows) => CommandBuilder::new_default_prog(),
            Self::System | Self::PowerShell if cfg!(windows) => {
                let mut command = CommandBuilder::new("powershell.exe");
                command.arg("-NoLogo");
                command
            }
            Self::Cmd if cfg!(windows) => CommandBuilder::new("cmd.exe"),
            _ => return Err(anyhow!("当前系统不支持此 Shell")),
        };
        command.env("TERM", "xterm-256color");
        Ok(command)
    }
}

enum Input {
    Bytes(Vec<u8>),
    Resize(PtySize),
}

struct Session {
    input: mpsc::Sender<Input>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Default)]
pub struct LocalManager {
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
}

impl LocalManager {
    pub fn open(
        &self,
        shell: LocalShell,
        cols: u16,
        rows: u16,
        events: Channel<TermEvent>,
    ) -> Result<SessionId> {
        let pty = native_pty_system().openpty(size(cols, rows))?;
        let mut reader = pty.master.try_clone_reader()?;
        let mut writer = pty.master.take_writer()?;
        let mut child = pty.slave.spawn_command(shell.command()?)?;
        drop(pty.slave);

        let id = SessionId::new();
        let (input, mut commands) = mpsc::channel(128);
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                input,
                killer: child.clone_killer(),
            },
        );

        let _ = events.send(TermEvent::State {
            state: SessionState::Ready,
        });
        thread::spawn(move || {
            while let Some(command) = commands.blocking_recv() {
                match command {
                    Input::Bytes(bytes) => {
                        if writer.write_all(&bytes).is_err() {
                            break;
                        }
                    }
                    Input::Resize(size) => {
                        let _ = pty.master.resize(size);
                    }
                }
            }
        });

        let output = events.clone();
        let read_thread = thread::spawn(move || {
            let mut buffer = [0; 8192];
            let mut decoder = EncodingDecoder::new(encoding_rs::UTF_8);
            let mut seq = 0;
            let mut send = |text| {
                seq += 1;
                output.send(TermEvent::Data { seq, text }).is_ok()
            };
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if decoder
                            .push(&buffer[..count])
                            .is_some_and(|text| !send(text))
                        {
                            return;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if let Some(text) = decoder.finish() {
                send(text);
            }
        });

        let manager = self.clone();
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            manager.sessions.lock().unwrap().remove(&id);
            // Drop the PTY's input and master before waiting for ConPTY output to drain.
            let _ = read_thread.join();
            let _ = events.send(TermEvent::Exit {
                code,
                reason: Some("本地终端已退出".into()),
            });
        });
        Ok(id)
    }

    async fn send(&self, id: SessionId, input: Input) -> Result<()> {
        let sender = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|session| session.input.clone());
        sender
            .ok_or_else(|| anyhow!("本地终端已退出"))?
            .send(input)
            .await
            .map_err(|_| anyhow!("本地终端已退出"))
    }

    pub async fn write(&self, id: SessionId, bytes: Vec<u8>) -> Result<()> {
        self.send(id, Input::Bytes(bytes)).await
    }

    pub async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        self.send(id, Input::Resize(size(cols, rows))).await
    }

    pub fn close(&self, id: SessionId) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            session.killer.kill()?;
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for (_, mut session) in sessions {
            if let Err(error) = session.killer.kill() {
                log::debug!("关闭本地终端失败: {error}");
            }
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}
