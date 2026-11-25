use anyhow::{anyhow, bail, Context, Result};
use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::{Channel as TauriChannel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex, Notify};

use crate::ipc::dto::{VncEvent, VncInputDto, VncState};
use crate::ipc::error::{AppError, AppResult};
use crate::session::model::{AuthRef, Profile, SessionId};
use crate::vault::Vault;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const ENCODING_RAW: i32 = 0;
const ENCODING_COPY_RECT: i32 = 1;
const ENCODING_DESKTOP_SIZE: i32 = -223;

pub enum VncInput {
    Pointer { mask: u8, x: u16, y: u16 },
    Key { down: bool, keysym: u32 },
    Close,
}

/// VNC 会话管理器：Rust 持有 RFB 连接与帧缓冲，前端只收脏矩形并绘制。
#[derive(Clone, Default)]
pub struct VncManager {
    sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
}

struct SessionHandle {
    input: mpsc::Sender<VncInput>,
    stop: Arc<Notify>,
}

impl VncManager {
    pub async fn open(
        &self,
        profile: Profile,
        vault: Arc<Vault>,
        on_event: TauriChannel<VncEvent>,
        on_frame: TauriChannel<InvokeResponseBody>,
    ) -> AppResult<SessionId> {
        let host = profile.target.host.trim().to_string();
        if host.is_empty() {
            return Err(AppError::new("vnc.invalid_host", "VNC 地址不能为空"));
        }
        if profile.target.port == 0 {
            return Err(AppError::new("vnc.invalid_port", "VNC 端口不合法"));
        }
        let password = match &profile.auth {
            AuthRef::Password { secret } => vault.get(secret).ok().map(|value| value.to_string()),
            _ => None,
        }
        .filter(|value| !value.is_empty());

        let _ = on_event.send(VncEvent::State {
            state: VncState::Connecting,
            message: None,
        });

        let stream = tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((host.as_str(), profile.target.port)),
        )
        .await
        .map_err(|_| AppError::new("vnc.timeout", "连接 VNC 服务器超时"))?
        .map_err(|error| {
            AppError::new(
                "vnc.connect_failed",
                format!("连接 {}:{} 失败：{error}", host, profile.target.port),
            )
        })?;
        let _ = stream.set_nodelay(true);

        let handshake = handshake(
            stream,
            password.as_deref(),
            profile.vnc_prefs().shared,
        )
        .await
        .map_err(|error| AppError::new("vnc.handshake_failed", format!("{error:#}")))?;

        let session_id = SessionId::new();
        let (tx, rx) = mpsc::channel::<VncInput>(256);
        let stop = Arc::new(Notify::new());
        self.sessions.lock().await.insert(
            session_id,
            SessionHandle {
                input: tx,
                stop: stop.clone(),
            },
        );

        let _ = on_event.send(VncEvent::State {
            state: VncState::Ready,
            message: None,
        });
        let _ = on_event.send(VncEvent::Size {
            width: handshake.width,
            height: handshake.height,
            name: handshake.name.clone(),
        });
        let _ = on_event.send(VncEvent::Clipboard {
            text: String::new(),
            from_server: true,
        });

        let manager = self.clone();
        tokio::spawn(async move {
            run_session(manager, session_id, handshake, rx, on_event, on_frame, stop).await;
        });

        Ok(session_id)
    }

    pub async fn input(&self, session: SessionId, input: VncInputDto) -> AppResult<()> {
        let command = match input {
            VncInputDto::Pointer { mask, x, y } => VncInput::Pointer { mask, x, y },
            VncInputDto::Key { down, keysym } => VncInput::Key { down, keysym },
        };
        self.sender(session)
            .await?
            .send(command)
            .await
            .map_err(|_| AppError::new("session.closed", "VNC 会话已关闭"))
    }

    pub async fn close(&self, session: SessionId) -> AppResult<()> {
        let handle = self.sessions.lock().await.remove(&session);
        let Some(handle) = handle else {
            return Ok(());
        };
        let _ = handle.input.send(VncInput::Close).await;
        handle.stop.notify_one();
        Ok(())
    }

    async fn sender(&self, session: SessionId) -> AppResult<mpsc::Sender<VncInput>> {
        self.sessions
            .lock()
            .await
            .get(&session)
            .map(|handle| handle.input.clone())
            .ok_or_else(|| AppError::new("session.not_found", "VNC 会话不存在或已关闭"))
    }
}

struct Handshake {
    stream: TcpStream,
    width: u16,
    height: u16,
    name: String,
    format: PixelFormat,
}

#[derive(Clone, Copy)]
struct PixelFormat {
    bpp: u8,
    big_endian: bool,
    red_max: u16,
    green_max: u16,
    blue_max: u16,
    red_shift: u8,
    green_shift: u8,
    blue_shift: u8,
}

async fn handshake(
    mut stream: TcpStream,
    password: Option<&str>,
    shared: bool,
) -> Result<Handshake> {
    let mut version = [0u8; 12];
    stream
        .read_exact(&mut version)
        .await
        .context("读取 VNC 版本失败")?;
    let text = String::from_utf8_lossy(&version);
    let minor = if text.starts_with("RFB 003.889") {
        // Apple 服务器固定发送 003.889，按 3.8 会话处理。
        8
    } else if text.starts_with("RFB 003.008") {
        8
    } else if text.starts_with("RFB 003.007") {
        7
    } else if text.starts_with("RFB 003.003") {
        3
    } else {
        bail!("不支持的 VNC 协议版本：{}", text.trim());
    };
    stream
        .write_all(format!("RFB 003.00{minor}\n").as_bytes())
        .await
        .context("发送 VNC 版本失败")?;

    let security = if minor == 3 {
        let value = stream.read_u32().await.context("读取安全类型失败")?;
        match value {
            0 => {
                let reason = read_reason(&mut stream).await?;
                bail!("服务器拒绝连接：{reason}");
            }
            1 | 2 => value as u8,
            other => bail!("不支持的 VNC 安全类型：{other}"),
        }
    } else {
        let count = stream.read_u8().await.context("读取安全类型数量失败")?;
        if count == 0 {
            let reason = read_reason(&mut stream).await?;
            bail!("服务器拒绝连接：{reason}");
        }
        let mut types = vec![0u8; count as usize];
        stream
            .read_exact(&mut types)
            .await
            .context("读取安全类型列表失败")?;
        match choose_security(&types, password.is_some()) {
            Some(value) => {
                // 3.7 起由客户端回送选定的安全类型。
                stream
                    .write_all(&[value])
                    .await
                    .context("发送认证方式失败")?;
                value
            }
            None => bail!("服务器只提供不支持的认证方式：{:?}", types),
        }
    };

    match security {
        1 => {}
        2 => {
            let password = password.ok_or_else(|| anyhow!("该 VNC 服务器要求密码"))?;
            let mut challenge = [0u8; 16];
            stream
                .read_exact(&mut challenge)
                .await
                .context("读取 VNC 认证挑战失败")?;
            let response = vnc_auth_response(password, &challenge);
            stream
                .write_all(&response)
                .await
                .context("发送 VNC 认证应答失败")?;
        }
        other => bail!("不支持的 VNC 安全类型：{other}"),
    }

    // 3.8 起即使 None 认证也会返回 SecurityResult。
    if minor == 8 || security == 2 {
        let result = stream.read_u32().await.context("读取认证结果失败")?;
        if result != 0 {
            let reason = read_reason(&mut stream).await.unwrap_or_default();
            if reason.is_empty() {
                bail!("VNC 认证失败");
            }
            bail!("VNC 认证失败：{reason}");
        }
    }

    stream
        .write_all(&[if shared { 1 } else { 0 }])
        .await
        .context("发送 ClientInit 失败")?;

    let width = stream.read_u16().await.context("读取画面宽度失败")?;
    let height = stream.read_u16().await.context("读取画面高度失败")?;
    if width == 0 || height == 0 {
        bail!("服务器返回了无效的画面尺寸 {width}x{height}");
    }
    let mut raw_format = [0u8; 16];
    stream
        .read_exact(&mut raw_format)
        .await
        .context("读取像素格式失败")?;
    let format = PixelFormat {
        bpp: raw_format[0],
        big_endian: raw_format[2] == 1,
        red_max: u16::from_be_bytes([raw_format[5], raw_format[6]]),
        green_max: u16::from_be_bytes([raw_format[7], raw_format[8]]),
        blue_max: u16::from_be_bytes([raw_format[9], raw_format[10]]),
        red_shift: raw_format[11],
        green_shift: raw_format[12],
        blue_shift: raw_format[13],
    };
    if raw_format[3] != 1 {
        bail!("暂不支持调色板模式的 VNC 服务器，请改用 24/32 位真彩色");
    }
    if !matches!(format.bpp, 8 | 16 | 32) {
        bail!("暂不支持 {} 位的 VNC 像素格式", format.bpp);
    }
    let name_len = stream.read_u32().await.context("读取桌面名称长度失败")? as usize;
    let name_len = name_len.min(4096);
    let mut name = vec![0u8; name_len];
    stream
        .read_exact(&mut name)
        .await
        .context("读取桌面名称失败")?;

    // 只请求 Raw / CopyRect / DesktopSize，避免依赖服务器可选的复杂编码。
    let mut encodings = Vec::with_capacity(4 + 12);
    encodings.extend_from_slice(&[2, 0]);
    encodings.extend_from_slice(&3u16.to_be_bytes());
    encodings.extend_from_slice(&ENCODING_RAW.to_be_bytes());
    encodings.extend_from_slice(&ENCODING_COPY_RECT.to_be_bytes());
    encodings.extend_from_slice(&ENCODING_DESKTOP_SIZE.to_be_bytes());
    stream
        .write_all(&encodings)
        .await
        .context("发送编码列表失败")?;
    request_update(&mut stream, false, 0, 0, width, height).await?;

    Ok(Handshake {
        stream,
        width,
        height,
        name: String::from_utf8_lossy(&name).trim().to_string(),
        format,
    })
}

fn choose_security(types: &[u8], has_password: bool) -> Option<u8> {
    if has_password && types.contains(&2) {
        Some(2)
    } else if types.contains(&1) {
        Some(1)
    } else if types.contains(&2) {
        Some(2)
    } else {
        None
    }
}

/// VNC 认证：密码截断/补零到 8 字节，按位反转后作为 DES 密钥加密挑战。
fn vnc_auth_response(password: &str, challenge: &[u8; 16]) -> [u8; 16] {
    let mut key = [0u8; 8];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = password
            .as_bytes()
            .get(index)
            .copied()
            .unwrap_or(0)
            .reverse_bits();
    }
    let cipher = des::Des::new(&Block::<des::Des>::clone_from_slice(&key));
    let mut response = [0u8; 16];
    for chunk in 0..2 {
        let mut block =
            Block::<des::Des>::clone_from_slice(&challenge[chunk * 8..chunk * 8 + 8]);
        cipher.encrypt_block(&mut block);
        response[chunk * 8..chunk * 8 + 8].copy_from_slice(&block);
    }
    response
}

async fn read_reason(stream: &mut TcpStream) -> Result<String> {
    let length = stream.read_u32().await.context("读取原因长度失败")? as usize;
    let length = length.min(4096);
    let mut buffer = vec![0u8; length];
    stream
        .read_exact(&mut buffer)
        .await
        .context("读取原因内容失败")?;
    Ok(String::from_utf8_lossy(&buffer).trim().to_string())
}

async fn request_update(
    stream: &mut TcpStream,
    incremental: bool,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> Result<()> {
    let mut message = Vec::with_capacity(10);
    message.push(3);
    message.push(if incremental { 1 } else { 0 });
    message.extend_from_slice(&x.to_be_bytes());
    message.extend_from_slice(&y.to_be_bytes());
    message.extend_from_slice(&width.to_be_bytes());
    message.extend_from_slice(&height.to_be_bytes());
    stream
        .write_all(&message)
        .await
        .context("请求画面更新失败")
}

async fn run_session(
    manager: VncManager,
    session_id: SessionId,
    handshake: Handshake,
    mut input_rx: mpsc::Receiver<VncInput>,
    on_event: TauriChannel<VncEvent>,
    on_frame: TauriChannel<InvokeResponseBody>,
    stop: Arc<Notify>,
) {
    let Handshake {
        stream,
        width,
        height,
        name: _name,
        format,
    } = handshake;
    let (mut reader, mut writer) = stream.into_split();

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
    // 写任务：接收画面更新请求与用户输入，避免读循环被 input 打断。
    let writer_stop = stop.clone();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = writer_stop.notified() => break,
                command = input_rx.recv() => {
                    match command {
                        Some(VncInput::Pointer { mask, x, y }) => {
                            let mut message = Vec::with_capacity(6);
                            message.push(5);
                            message.push(mask);
                            message.extend_from_slice(&x.to_be_bytes());
                            message.extend_from_slice(&y.to_be_bytes());
                            if writer.write_all(&message).await.is_err() { break; }
                        }
                        Some(VncInput::Key { down, keysym }) => {
                            let mut message = Vec::with_capacity(8);
                            message.push(4);
                            message.push(if down { 1 } else { 0 });
                            message.extend_from_slice(&[0, 0]);
                            message.extend_from_slice(&keysym.to_be_bytes());
                            if writer.write_all(&message).await.is_err() { break; }
                        }
                        Some(VncInput::Close) | None => {
                            let _ = writer.shutdown().await;
                            break;
                        }
                    }
                }
                data = outbound_rx.recv() => {
                    match data {
                        Some(bytes) => {
                            if writer.write_all(&bytes).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
            }
        }
    });

    let mut framebuffer = Framebuffer::new(width, height);
    let mut reason = "连接已关闭".to_string();
    let result = read_loop(
        &mut reader,
        &mut framebuffer,
        format,
        &outbound_tx,
        &on_event,
        &on_frame,
        &stop,
    )
    .await;
    if let Err(error) = result {
        reason = format!("{error:#}");
    }
    stop.notify_one();
    drop(outbound_tx);
    let _ = writer_task.await;
    manager.sessions.lock().await.remove(&session_id);
    if reason == "连接已关闭" {
        let _ = on_event.send(VncEvent::State {
            state: VncState::Closed,
            message: None,
        });
    } else {
        let _ = on_event.send(VncEvent::State {
            state: VncState::Error,
            message: Some(reason.clone()),
        });
    }
    let _ = on_event.send(VncEvent::Exit { reason: Some(reason) });
}

async fn read_loop(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
    framebuffer: &mut Framebuffer,
    format: PixelFormat,
    outbound: &mpsc::Sender<Vec<u8>>,
    on_event: &TauriChannel<VncEvent>,
    on_frame: &TauriChannel<InvokeResponseBody>,
    stop: &Arc<Notify>,
) -> Result<()> {
    loop {
        let message = tokio::select! {
            _ = stop.notified() => return Ok(()),
            message = reader.read_u8() => message.context("读取服务器消息类型失败")?,
        };
        match message {
            0 => {
                let padding = reader.read_u8().await?;
                let _ = padding;
                let count = reader.read_u16().await?;
                for _ in 0..count {
                    let x = reader.read_u16().await?;
                    let y = reader.read_u16().await?;
                    let width = reader.read_u16().await?;
                    let height = reader.read_u16().await?;
                    let encoding = reader.read_i32().await?;
                    match encoding {
                        ENCODING_RAW => {
                            read_raw_rect(reader, framebuffer, format, x, y, width, height).await?;
                            send_frame(on_frame, framebuffer, x, y, width, height)?;
                        }
                        ENCODING_COPY_RECT => {
                            let src_x = reader.read_u16().await?;
                            let src_y = reader.read_u16().await?;
                            framebuffer.copy_rect(x, y, width, height, src_x, src_y)?;
                            let _ = on_event.send(VncEvent::CopyRect {
                                x,
                                y,
                                width,
                                height,
                                src_x,
                                src_y,
                            });
                        }
                        ENCODING_DESKTOP_SIZE => {
                            framebuffer.resize(width, height);
                            let _ = on_event.send(VncEvent::Size {
                                width,
                                height,
                                name: String::new(),
                            });
                        }
                        other => bail!("服务器使用了未协商的编码：{other}"),
                    }
                }
                let mut request = Vec::with_capacity(10);
                request.push(3);
                request.push(1);
                request.extend_from_slice(&0u16.to_be_bytes());
                request.extend_from_slice(&0u16.to_be_bytes());
                request.extend_from_slice(&framebuffer.width.to_be_bytes());
                request.extend_from_slice(&framebuffer.height.to_be_bytes());
                if outbound.send(request).await.is_err() {
                    bail!("连接已关闭");
                }
            }
            1 => {
                // SetColourMapEntries：真彩色会话用不到，读完丢弃。
                let _ = reader.read_u8().await?;
                let _ = reader.read_u16().await?;
                let count = reader.read_u16().await?;
                let mut skip = vec![0u8; count as usize * 6];
                reader.read_exact(&mut skip).await?;
            }
            2 => {
                let _ = on_event.send(VncEvent::Bell);
            }
            3 => {
                let mut padding = [0u8; 3];
                reader.read_exact(&mut padding).await?;
                let length = reader.read_u32().await? as usize;
                if length > 4 * 1024 * 1024 {
                    bail!("服务器剪贴板内容过大");
                }
                let mut text = vec![0u8; length];
                reader.read_exact(&mut text).await?;
                let _ = on_event.send(VncEvent::Clipboard {
                    text: String::from_utf8_lossy(&text).to_string(),
                    from_server: true,
                });
            }
            other => bail!("不支持的服务器消息类型：{other}"),
        }
    }
}

async fn read_raw_rect(
    reader: &mut tokio::net::tcp::OwnedReadHalf,
    framebuffer: &mut Framebuffer,
    format: PixelFormat,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> Result<()> {
    let bytes_per_pixel = format.bpp as usize / 8;
    let size = width as usize * height as usize * bytes_per_pixel;
    if size > 64 * 1024 * 1024 {
        bail!("服务器返回的画面块过大");
    }
    let mut pixels = vec![0u8; size];
    reader
        .read_exact(&mut pixels)
        .await
        .context("读取画面数据失败")?;

    for row in 0..height as usize {
        for column in 0..width as usize {
            let offset = (row * width as usize + column) * bytes_per_pixel;
            let value = match format.bpp {
                8 => pixels[offset] as u32,
                16 => {
                    let slice = [pixels[offset], pixels[offset + 1]];
                    if format.big_endian {
                        u16::from_be_bytes(slice) as u32
                    } else {
                        u16::from_le_bytes(slice) as u32
                    }
                }
                _ => {
                    let slice = [
                        pixels[offset],
                        pixels[offset + 1],
                        pixels[offset + 2],
                        pixels[offset + 3],
                    ];
                    if format.big_endian {
                        u32::from_be_bytes(slice)
                    } else {
                        u32::from_le_bytes(slice)
                    }
                }
            };
            let red = scale_channel(value, format.red_shift, format.red_max);
            let green = scale_channel(value, format.green_shift, format.green_max);
            let blue = scale_channel(value, format.blue_shift, format.blue_max);
            framebuffer.blit_pixel(x as usize + column, y as usize + row, red, green, blue);
        }
    }
    Ok(())
}

fn scale_channel(value: u32, shift: u8, max: u16) -> u8 {
    if max == 0 {
        return 0;
    }
    let channel = (value >> shift) & max as u32;
    ((channel * 255 + max as u32 / 2) / max as u32) as u8
}

fn send_frame(
    on_frame: &TauriChannel<InvokeResponseBody>,
    framebuffer: &Framebuffer,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
) -> Result<()> {
    if width == 0 || height == 0 {
        return Ok(());
    }
    let mut payload = Vec::with_capacity(8 + width as usize * height as usize * 4);
    payload.extend_from_slice(&x.to_be_bytes());
    payload.extend_from_slice(&y.to_be_bytes());
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    for row in 0..height as usize {
        let start = ((y as usize + row) * framebuffer.width as usize + x as usize) * 4;
        let end = start + width as usize * 4;
        if end > framebuffer.pixels.len() {
            bail!("画面块超出缓冲区");
        }
        payload.extend_from_slice(&framebuffer.pixels[start..end]);
    }
    on_frame
        .send(InvokeResponseBody::Raw(payload))
        .map_err(|error| anyhow!("发送画面帧失败：{error}"))
}

struct Framebuffer {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
}

impl Framebuffer {
    fn new(width: u16, height: u16) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; width as usize * height as usize * 4],
        }
    }

    fn resize(&mut self, width: u16, height: u16) {
        if width == self.width && height == self.height {
            return;
        }
        self.width = width;
        self.height = height;
        self.pixels = vec![0u8; width as usize * height as usize * 4];
    }

    fn blit_pixel(&mut self, x: usize, y: usize, red: u8, green: u8, blue: u8) {
        if x >= self.width as usize || y >= self.height as usize {
            return;
        }
        let offset = (y * self.width as usize + x) * 4;
        self.pixels[offset] = red;
        self.pixels[offset + 1] = green;
        self.pixels[offset + 2] = blue;
        self.pixels[offset + 3] = 255;
    }

    fn copy_rect(
        &mut self,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        src_x: u16,
        src_y: u16,
    ) -> Result<()> {
        if x as u32 + width as u32 > self.width as u32 || y as u32 + height as u32 > self.height as u32 {
            bail!("CopyRect 目标区域越界");
        }
        if src_x as u32 + width as u32 > self.width as u32
            || src_y as u32 + height as u32 > self.height as u32
        {
            bail!("CopyRect 源区域越界");
        }
        if x == src_x && y == src_y {
            return Ok(());
        }
        let mut copy = Vec::with_capacity(width as usize * height as usize * 4);
        for row in 0..height as usize {
            let start = ((src_y as usize + row) * self.width as usize + src_x as usize) * 4;
            copy.extend_from_slice(&self.pixels[start..start + width as usize * 4]);
        }
        for row in 0..height as usize {
            let start = ((y as usize + row) * self.width as usize + x as usize) * 4;
            let source = row * width as usize * 4;
            self.pixels[start..start + width as usize * 4]
                .copy_from_slice(&copy[source..source + width as usize * 4]);
        }
        Ok(())
    }
}
