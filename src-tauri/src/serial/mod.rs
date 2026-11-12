use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{self, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel as TauriChannel;

use crate::ipc::dto::{SerialPortInfo, SessionState, TermEvent};
use crate::ipc::error::{AppError, AppResult};
use crate::session::manager::Utf8Decoder;
use crate::session::model::{Profile, SerialFlowControl, SerialParity, SerialPrefs, SessionId};

/// 串口会话的写侧命令。读写都收敛到一个后台线程，避免句柄共享与残留线程。
enum SerialCommand {
    Write(Vec<u8>),
    SetLines { dtr: bool, rts: bool },
    Close,
}

/// 串口会话管理器。与 SSH 的 `SshManager` 平行，输出仍走 `TermEvent` 聚合管线。
#[derive(Clone, Default)]
pub struct SerialManager {
    sessions: Arc<Mutex<HashMap<SessionId, Sender<SerialCommand>>>>,
}

impl SerialManager {
    /// 枚举系统串口。描述里带上厂商/产品/序列号，方便区分多个同型号 USB 转串口。
    pub fn list_ports() -> AppResult<Vec<SerialPortInfo>> {
        let mut ports = serialport::available_ports()
            .map_err(|e| AppError::new("serial.list_failed", format!("枚举串口失败：{e}")))?;
        ports.sort_by(|a, b| port_sort_key(&a.port_name).cmp(&port_sort_key(&b.port_name)));
        Ok(ports
            .into_iter()
            .map(|port| SerialPortInfo {
                description: describe_port(&port.port_type),
                port_name: port.port_name,
            })
            .collect())
    }

    pub fn open(
        &self,
        profile: Profile,
        on_event: TauriChannel<TermEvent>,
    ) -> AppResult<SessionId> {
        let prefs = profile.serial_prefs();
        let port_name = prefs.port.trim().to_string();
        if port_name.is_empty() {
            return Err(AppError::new("serial.invalid_port", "请先选择串口端口"));
        }

        let mut port = build_port(&port_name, &prefs).map_err(|err| open_error(&port_name, err))?;

        // 默认拉高 DTR/RTS：部分交换机 console 需要 DTR 有效才会有输出。
        if let Err(err) = port.write_data_terminal_ready(prefs.dtr) {
            log::warn!("[fanssh] 设置 DTR 失败: {err}");
        }
        if let Err(err) = port.write_request_to_send(prefs.rts) {
            log::warn!("[fanssh] 设置 RTS 失败: {err}");
        }

        let session_id = SessionId::new();
        let (tx, rx) = mpsc::channel::<SerialCommand>();
        self.sessions.lock().unwrap().insert(session_id, tx);

        let _ = on_event.send(TermEvent::State {
            state: SessionState::Connecting,
        });
        let _ = on_event.send(TermEvent::State {
            state: SessionState::Ready,
        });
        let _ = on_event.send(TermEvent::Title {
            title: profile.name.clone(),
        });

        let manager = self.clone();
        let title = profile.name.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("serial-{title}"))
            .spawn(move || run_serial(manager, session_id, port, rx, on_event));
        if let Err(err) = spawned {
            self.sessions.lock().unwrap().remove(&session_id);
            return Err(AppError::new(
                "serial.thread_failed",
                format!("启动串口线程失败：{err}"),
            ));
        }

        Ok(session_id)
    }

    pub fn write(&self, session: SessionId, bytes: Vec<u8>) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.sender(session)?
            .send(SerialCommand::Write(bytes))
            .map_err(|_| AppError::new("session.closed", "串口会话已关闭"))
    }

    /// 运行中切换 DTR / RTS，立即对当前句柄生效。
    pub fn set_lines(&self, session: SessionId, dtr: bool, rts: bool) -> AppResult<()> {
        self.sender(session)?
            .send(SerialCommand::SetLines { dtr, rts })
            .map_err(|_| AppError::new("session.closed", "串口会话已关闭"))
    }

    pub fn close(&self, session: SessionId) -> AppResult<()> {
        self.sender(session)?
            .send(SerialCommand::Close)
            .map_err(|_| AppError::new("session.closed", "串口会话已关闭"))
    }

    fn sender(&self, session: SessionId) -> AppResult<Sender<SerialCommand>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session)
            .cloned()
            .ok_or_else(|| AppError::new("session.not_found", "会话不存在或已关闭"))
    }
}

fn build_port(port: &str, prefs: &SerialPrefs) -> serialport::Result<Box<dyn serialport::SerialPort>> {
    let data_bits = match prefs.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };
    let stop_bits = if prefs.stop_bits == 2 {
        serialport::StopBits::Two
    } else {
        serialport::StopBits::One
    };
    let parity = match prefs.parity {
        SerialParity::Odd => serialport::Parity::Odd,
        SerialParity::Even => serialport::Parity::Even,
        SerialParity::None => serialport::Parity::None,
    };
    let flow_control = match prefs.flow_control {
        SerialFlowControl::Hardware => serialport::FlowControl::Hardware,
        SerialFlowControl::Software => serialport::FlowControl::Software,
        SerialFlowControl::None => serialport::FlowControl::None,
    };
    serialport::new(port, prefs.baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(20))
        .open()
}

/// 把底层错误翻译成用户能理解的“被占用 / 不存在”，而不是只抛 errno。
fn open_error(port: &str, err: serialport::Error) -> AppError {
    let (code, reason) = match err.kind() {
        serialport::ErrorKind::NoDevice => ("serial.not_found", "串口不存在或已被拔出"),
        serialport::ErrorKind::Io(kind) if kind == std::io::ErrorKind::PermissionDenied => {
            ("serial.busy", "串口被其他程序占用，或当前用户没有访问权限")
        }
        serialport::ErrorKind::Io(kind) if kind == std::io::ErrorKind::NotFound => {
            ("serial.not_found", "串口不存在或已被拔出")
        }
        _ => ("serial.open_failed", "打开串口失败（端口可能被占用或权限不足）"),
    };
    AppError::new(code, format!("{reason}（{port}）：{err}"))
}

fn is_read_timeout(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::TimedOut
}

fn port_sort_key(name: &str) -> (u8, u32, String) {
    if let Some(rest) = name.strip_prefix("COM") {
        if let Ok(number) = rest.parse::<u32>() {
            return (0, number, name.to_string());
        }
    }
    (1, 0, name.to_string())
}

fn describe_port(kind: &serialport::SerialPortType) -> String {
    match kind {
        serialport::SerialPortType::UsbPort(info) => {
            let mut name = String::new();
            if let Some(manufacturer) = &info.manufacturer {
                name.push_str(manufacturer);
            }
            if let Some(product) = &info.product {
                if !name.is_empty() {
                    name.push(' ');
                }
                name.push_str(product);
            }
            if name.is_empty() {
                name = format!("USB 串口 {:04X}:{:04X}", info.vid, info.pid);
            }
            if let Some(serial) = &info.serial_number {
                name.push_str(&format!(" · SN {serial}"));
            }
            name
        }
        serialport::SerialPortType::BluetoothPort => "蓝牙串口".to_string(),
        serialport::SerialPortType::PciPort => "PCI 串口".to_string(),
        _ => String::new(),
    }
}

fn run_serial(
    manager: SerialManager,
    session_id: SessionId,
    mut port: Box<dyn serialport::SerialPort>,
    rx: mpsc::Receiver<SerialCommand>,
    on_event: TauriChannel<TermEvent>,
) {
    let mut decoder = Utf8Decoder::default();
    let mut buffer = String::new();
    let mut seq = 0u64;
    let mut read_buf = [0u8; 4096];
    let mut reason = "串口已断开".to_string();
    let mut last_flush = Instant::now();

    loop {
        // 先处理写侧命令（写入、DTR/RTS、关闭），再读一次数据。
        'commands: loop {
            match rx.try_recv() {
                Ok(SerialCommand::Write(bytes)) => {
                    if let Err(err) = port.write_all(&bytes).and_then(|_| port.flush()) {
                        reason = format!("写入串口失败：{err}");
                        break 'commands;
                    }
                }
                Ok(SerialCommand::SetLines { dtr, rts }) => {
                    if let Err(err) = port.write_data_terminal_ready(dtr) {
                        log::warn!("[fanssh] 设置 DTR 失败: {err}");
                    }
                    if let Err(err) = port.write_request_to_send(rts) {
                        log::warn!("[fanssh] 设置 RTS 失败: {err}");
                    }
                }
                Ok(SerialCommand::Close) => {
                    reason = "用户关闭会话".to_string();
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    reason = "会话已释放".to_string();
                    break;
                }
            }
        }
        if reason != "串口已断开" {
            break;
        }

        match port.read(&mut read_buf) {
            Ok(0) => {}
            Ok(size) => {
                if let Some(text) = decoder.push(&read_buf[..size]) {
                    buffer.push_str(&text);
                }
            }
            Err(err) if is_read_timeout(&err) => {}
            Err(err) => {
                reason = format!("串口连接中断（设备可能已拔出）：{err}");
                break;
            }
        }
        // 串口读超时为 20ms，这里按 16ms 或 4KB 聚合，避免输出长时间不刷到终端。
        if !buffer.is_empty()
            && (buffer.len() >= 4 * 1024 || last_flush.elapsed() >= Duration::from_millis(16))
        {
            flush(&mut buffer, &mut seq, &on_event);
            last_flush = Instant::now();
        }
    }

    flush(&mut buffer, &mut seq, &on_event);
    manager.sessions.lock().unwrap().remove(&session_id);
    // 显式释放句柄，确保拔线/断开后不占用端口。
    drop(port);
    let _ = on_event.send(TermEvent::State {
        state: SessionState::Closed {
            reason: reason.clone(),
        },
    });
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
