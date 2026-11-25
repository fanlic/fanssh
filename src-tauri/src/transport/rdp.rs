// ---------------------------------------------------------------------------
// 内嵌 RDP（Windows / Linux 共用）
//
// 首批能力：Bitmap + RemoteFX 帧解码 + 键盘/鼠标输入 + NLA/CredSSP。
// 后续批次：EGFX/H.264、剪贴板重定向、多显示器、音频重定向、磁盘映射。
// Windows 上 mstsc 支持而本实现暂不支持的：智能卡登录、RD 网关；
// 这些能力必须在界面上明确标注，不能静默缺失。
// ---------------------------------------------------------------------------

mod embedded {
    use std::collections::HashMap;
    use std::io;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context as TaskContext, Poll};
    use std::time::Duration;

    use anyhow::{anyhow, bail, Context, Result};
    use ironrdp_connector::{ClientConnector, Credentials, DesktopSize, ServerName};
    use ironrdp_graphics::image_processing::PixelFormat;
    use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
    use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};
    use ironrdp_pdu::gcc::{ConnectionType, KeyboardType};
    use ironrdp_pdu::input::fast_path::FastPathInputEvent;
    use ironrdp_pdu::rdp::capability_sets::{self, MajorPlatformType, RailSupportLevel};
    use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
    use ironrdp_session::image::DecodedImage;
    use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
    use ironrdp_tokio::reqwest::ReqwestNetworkClient;
    use ironrdp_tokio::{connect_begin, connect_finalize, mark_as_upgraded, split_tokio_framed, TokioFramed};
    use ironrdp_tokio::FramedWrite as _;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::{pki_types, DigitallySignedStruct, SignatureScheme};
    use tauri::ipc::{Channel as TauriChannel, InvokeResponseBody};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, WriteHalf};
    use tokio::net::TcpStream;
    use tokio::sync::{mpsc, Mutex, Notify};
    use tokio_rustls::client::TlsStream;
    use tokio_rustls::TlsConnector;

    use crate::ipc::dto::{RdpEvent, RdpInputDto, RdpState};
    use crate::ipc::error::{AppError, AppResult};
    use crate::session::model::{AuthRef, Profile, SessionId};
    use crate::vault::Vault;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
    const NEGOTIATE_TIMEOUT: Duration = Duration::from_secs(20);
    const TLS_TIMEOUT: Duration = Duration::from_secs(20);
    const FINALIZE_TIMEOUT: Duration = Duration::from_secs(30);

    pub enum RdpInput {
        Pointer { mask: u8, x: u16, y: u16 },
        Key { down: bool, scancode: u16 },
        Close,
    }

    /// 内嵌 RDP 会话管理器：Rust 持有 ironrdp 连接与帧缓冲，前端只收脏矩形。
    #[derive(Clone, Default)]
    pub struct RdpManager {
        sessions: Arc<Mutex<HashMap<SessionId, SessionHandle>>>,
    }

    struct SessionHandle {
        input: mpsc::Sender<RdpInput>,
        stop: Arc<Notify>,
    }

    impl RdpManager {
        pub async fn open(
            &self,
            profile: Profile,
            vault: Arc<Vault>,
            password: Option<String>,
            on_event: TauriChannel<RdpEvent>,
            on_frame: TauriChannel<InvokeResponseBody>,
        ) -> AppResult<SessionId> {
            let host = profile.target.host.trim().to_string();
            if host.is_empty() {
                return Err(AppError::new("rdp.invalid_host", "RDP 地址不能为空"));
            }
            if profile.target.port == 0 {
                return Err(AppError::new("rdp.invalid_port", "RDP 端口不合法"));
            }

            // 密码只存在内存中：优先使用本次一次性输入，其次从 vault 解密。
            let stored = match &profile.auth {
                AuthRef::Password { secret } => vault.get(secret).ok().map(|value| value.to_string()),
                _ => None,
            }
            .filter(|value| !value.is_empty());
            let password = match password {
                Some(value) => value,
                None => stored.ok_or_else(|| {
                    AppError::new(
                        "rdp.password_required",
                        "该 RDP 配置没有可用密码，请一次性输入后重试",
                    )
                })?,
            };

            let prefs = profile.rdp_prefs();
            let user = profile.target.user.trim().to_string();
            let domain = prefs
                .domain
                .as_ref()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let name = profile.name.clone();

            let _ = on_event.send(RdpEvent::State {
                state: RdpState::Connecting,
                message: None,
            });

            let connected = connect(
                &host,
                profile.target.port,
                &user,
                domain,
                &password,
                prefs.width,
                prefs.height,
            )
            .await
            .map_err(to_app_error)?;

            let session_id = SessionId::new();
            let (tx, rx) = mpsc::channel::<RdpInput>(256);
            let stop = Arc::new(Notify::new());
            self.sessions.lock().await.insert(
                session_id,
                SessionHandle {
                    input: tx,
                    stop: stop.clone(),
                },
            );

            let _ = on_event.send(RdpEvent::State {
                state: RdpState::Ready,
                message: None,
            });
            let _ = on_event.send(RdpEvent::Size {
                width: connected.image.width(),
                height: connected.image.height(),
                name,
            });

            let manager = self.clone();
            tokio::spawn(run_session(
                manager, session_id, connected, rx, on_event, on_frame, stop,
            ));

            Ok(session_id)
        }

        pub async fn input(&self, session: SessionId, input: RdpInputDto) -> AppResult<()> {
            let command = match input {
                RdpInputDto::Pointer { mask, x, y } => RdpInput::Pointer { mask, x, y },
                RdpInputDto::Key { down, scancode } => RdpInput::Key { down, scancode },
            };
            self.sender(session)
                .await?
                .send(command)
                .await
                .map_err(|_| AppError::new("session.closed", "RDP 会话已关闭"))
        }

        pub async fn close(&self, session: SessionId) -> AppResult<()> {
            let handle = self.sessions.lock().await.remove(&session);
            let Some(handle) = handle else {
                return Ok(());
            };
            let _ = handle.input.send(RdpInput::Close).await;
            handle.stop.notify_one();
            Ok(())
        }

        async fn sender(&self, session: SessionId) -> AppResult<mpsc::Sender<RdpInput>> {
            self.sessions
                .lock()
                .await
                .get(&session)
                .map(|handle| handle.input.clone())
                .ok_or_else(|| AppError::new("session.not_found", "RDP 会话不存在或已关闭"))
        }
    }

    struct Connected {
        framed: TokioFramed<RdpStream>,
        image: DecodedImage,
        stage: ActiveStage,
    }

    async fn connect(
        host: &str,
        port: u16,
        user: &str,
        domain: Option<String>,
        password: &str,
        width: u32,
        height: u32,
    ) -> Result<Connected> {
        let desktop_width = width.clamp(640, 4096) as u16;
        let desktop_height = height.clamp(480, 4096) as u16;
        let config = build_config(user, domain, password, desktop_width, desktop_height)?;

        let socket = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| anyhow!("连接 {host}:{port} 超时"))?
            .with_context(|| format!("连接 {host}:{port} 失败"))?;
        let _ = socket.set_nodelay(true);
        let client_addr = socket.local_addr().context("读取本地套接字地址失败")?;

        let mut framed = TokioFramed::new(RdpStream::Tcp(socket));
        let mut connector = ClientConnector::new(config, client_addr);

        let should_upgrade = tokio::time::timeout(
            NEGOTIATE_TIMEOUT,
            connect_begin(&mut framed, &mut connector),
        )
        .await
        .map_err(|_| anyhow!("RDP 安全协商超时"))?
        .map_err(|error| anyhow!("RDP 安全协商失败：{error}"))?;

        let stream = framed.into_inner_no_leftover();
        let RdpStream::Tcp(socket) = stream else {
            bail!("RDP 连接状态异常（TLS 前不是明文 TCP）");
        };
        let (tls, server_public_key) = tls_upgrade(socket, host).await?;

        let upgraded = mark_as_upgraded(should_upgrade, &mut connector);
        let mut framed = TokioFramed::new(RdpStream::Tls(tls));

        // Kerberos 只用于少数域环境；网络请求交给 reqwest 实现，普通 NLA 不触发。
        let mut network_client = ReqwestNetworkClient::new();
        let outcome = tokio::time::timeout(
            FINALIZE_TIMEOUT,
            connect_finalize(
                upgraded,
                connector,
                &mut framed,
                &mut network_client,
                ServerName::new(host),
                server_public_key,
                None,
            ),
        )
        .await
        .map_err(|_| anyhow!("RDP 登录阶段超时"))?
        .map_err(|error| anyhow!("RDP 登录阶段失败：{error}"))?;
        let result = outcome
            .into_connected()
            .map_err(|error| anyhow!("{error}"))?;

        let desktop = result.desktop_size;
        let image = DecodedImage::new(PixelFormat::RgbA32, desktop.width, desktop.height);
        let stage = ActiveStageBuilder {
            static_channels: result.static_channels,
            user_channel_id: result.user_channel_id,
            io_channel_id: result.io_channel_id,
            message_channel_id: result.message_channel_id,
            share_id: result.share_id,
            compression_type: result.compression_type,
            enable_server_pointer: result.enable_server_pointer,
            pointer_software_rendering: result.pointer_software_rendering,
        }
        .build();

        Ok(Connected {
            framed,
            image,
            stage,
        })
    }

    fn build_config(
        user: &str,
        domain: Option<String>,
        password: &str,
        width: u16,
        height: u16,
    ) -> Result<ironrdp_connector::Config> {
        // 首批只协商 RemoteFX；EGFX/H.264 留给后续批次。
        let codecs = capability_sets::client_codecs_capabilities(&["remotefx"])
            .map_err(|error| anyhow!("初始化 RemoteFX 编解码能力失败：{error}"))?;

        Ok(ironrdp_connector::Config {
            desktop_size: DesktopSize { width, height },
            monitor_layout: None,
            desktop_scale_factor: 0,
            desktop_physical_size: None,
            desktop_orientation: None,
            device_scale_factor: None,
            monitor_extended_layout: None,
            relative_mouse_input: false,
            enable_tls: true,
            enable_credssp: true,
            enable_standard_rdp_security: false,
            credentials: Credentials::UsernamePassword {
                username: user.to_string(),
                password: password.to_string(),
            },
            domain,
            client_build: 0,
            client_name: "FanSSH".to_string(),
            keyboard_type: KeyboardType::IBM_ENHANCED,
            keyboard_subtype: 0,
            keyboard_functional_keys_count: 12,
            keyboard_layout: 0,
            connection_type: ConnectionType::Lan,
            ime_file_name: String::new(),
            bitmap: Some(ironrdp_connector::BitmapConfig {
                lossy_compression: true,
                color_depth: 32,
                codecs,
            }),
            dig_product_id: String::new(),
            client_dir: "C:\\Windows\\System32\\mstscax.dll".to_string(),
            alternate_shell: String::new(),
            work_dir: String::new(),
            remote_application_mode: false,
            rail_support_level: RailSupportLevel::empty(),
            platform: MajorPlatformType::UNIX,
            hardware_id: None,
            request_data: None,
            autologon: true,
            enable_audio_playback: false,
            enable_audio_capture: false,
            performance_flags: PerformanceFlags::default(),
            license_cache: None,
            timezone_info: TimezoneInfo::default(),
            compression_type: Some(CompressionType::Rdp61),
            enable_server_pointer: true,
            pointer_software_rendering: true,
            multitransport_flags: None,
            // EGFX/GFX 管道属于后续批次，明确不宣告，避免服务器把画面送到未处理的动态通道。
            support_dyn_vc_gfx_protocol: false,
        })
    }

    async fn tls_upgrade(
        stream: TcpStream,
        host: &str,
    ) -> Result<(TlsStream<TcpStream>, Vec<u8>)> {
        let config = Arc::new(tls_config());
        let connector = TlsConnector::from(config);
        let server_name = pki_types::ServerName::try_from(host.to_string())
            .map_err(|error| anyhow!("无效的 RDP 服务器名称 {host}：{error}"))?;
        let tls = tokio::time::timeout(TLS_TIMEOUT, connector.connect(server_name, stream))
            .await
            .map_err(|_| anyhow!("连接 {host} 的 TLS 握手超时"))?
            .context("RDP TLS 握手失败")?;

        let certificate = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|certificates| certificates.first())
            .ok_or_else(|| anyhow!("RDP 服务器没有提供 TLS 证书"))?;
        let server_public_key = extract_spki(certificate.as_ref())?;

        Ok((tls, server_public_key))
    }

    fn tls_config() -> rustls::ClientConfig {
        // RDP 服务器普遍使用自签证书；这里接受任意证书，SPKI 仍会传给 CredSSP 做通道绑定。
        let mut config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_no_client_auth();
        // CredSSP 不支持 TLS 会话恢复。
        config.resumption = rustls::client::Resumption::disabled();
        config
    }

    fn extract_spki(certificate_der: &[u8]) -> Result<Vec<u8>> {
        use x509_cert::der::Decode as _;

        let certificate = x509_cert::Certificate::from_der(certificate_der)
            .context("解析 RDP 服务器证书失败")?;
        let key = certificate
            .tbs_certificate()
            .subject_public_key_info()
            .subject_public_key
            .as_bytes()
            .ok_or_else(|| anyhow!("RDP 服务器证书的公钥位串未对齐"))?;
        Ok(key.to_vec())
    }

    #[derive(Debug)]
    struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _end_entity: &pki_types::CertificateDer<'_>,
            _intermediates: &[pki_types::CertificateDer<'_>],
            _server_name: &pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _certificate: &pki_types::CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _certificate: &pki_types::CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA1,
                SignatureScheme::ECDSA_SHA1_Legacy,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
                SignatureScheme::ED448,
            ]
        }
    }

    /// 明文 TCP 与 TLS 共用一个 Framed 类型，避免连接阶段切换泛型带来的重复代码。
    enum RdpStream {
        Tcp(TcpStream),
        Tls(TlsStream<TcpStream>),
    }

    impl AsyncRead for RdpStream {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
                Self::Tls(stream) => Pin::new(stream).poll_read(cx, buf),
            }
        }
    }

    impl AsyncWrite for RdpStream {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            match self.get_mut() {
                Self::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
                Self::Tls(stream) => Pin::new(stream).poll_write(cx, buf),
            }
        }

        fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Self::Tcp(stream) => Pin::new(stream).poll_flush(cx),
                Self::Tls(stream) => Pin::new(stream).poll_flush(cx),
            }
        }

        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
                Self::Tls(stream) => Pin::new(stream).poll_shutdown(cx),
            }
        }
    }

    async fn run_session(
        manager: RdpManager,
        session_id: SessionId,
        connected: Connected,
        mut input_rx: mpsc::Receiver<RdpInput>,
        on_event: TauriChannel<RdpEvent>,
        on_frame: TauriChannel<InvokeResponseBody>,
        stop: Arc<Notify>,
    ) {
        let Connected {
            framed,
            mut image,
            mut stage,
        } = connected;
        let (mut reader, mut writer) = split_tokio_framed(framed);
        let mut database = Database::new();
        let mut previous_mask = 0u8;
        let mut terminated: Option<String> = None;

        let result = async {
            loop {
                tokio::select! {
                    _ = stop.notified() => break,
                    input = input_rx.recv() => {
                        match input {
                            Some(RdpInput::Close) | None => break,
                            Some(input) => {
                                let events = input_events(&mut database, &mut previous_mask, input);
                                if events.is_empty() {
                                    continue;
                                }
                                let outputs = stage.process_fastpath_input(&mut image, &events)?;
                                if let Some(reason) =
                                    handle_outputs(outputs, &mut writer, &image, &on_frame).await?
                                {
                                    terminated = Some(reason);
                                    break;
                                }
                            }
                        }
                    }
                    pdu = reader.read_pdu() => {
                        let (action, payload) = pdu.context("读取 RDP 数据失败")?;
                        let received_at = reader.last_read_at();
                        let outputs = stage.process(&mut image, action, &payload, received_at)?;
                        if let Some(reason) =
                            handle_outputs(outputs, &mut writer, &image, &on_frame).await?
                        {
                            terminated = Some(reason);
                            break;
                        }
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;

        manager.sessions.lock().await.remove(&session_id);

        let (state, message) = match (&result, terminated) {
            (Err(error), _) => (RdpState::Error, Some(format!("{error:#}"))),
            (Ok(()), Some(reason)) => (RdpState::Closed, Some(reason)),
            (Ok(()), None) => (RdpState::Closed, None),
        };
        let _ = on_event.send(RdpEvent::State {
            state,
            message: message.clone(),
        });
        let _ = on_event.send(RdpEvent::Exit { reason: message });
    }

    async fn handle_outputs(
        outputs: Vec<ActiveStageOutput>,
        writer: &mut TokioFramed<WriteHalf<RdpStream>>,
        image: &DecodedImage,
        on_frame: &TauriChannel<InvokeResponseBody>,
    ) -> Result<Option<String>> {
        for output in outputs {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if !frame.is_empty() {
                        writer
                            .write_all(&frame)
                            .await
                            .context("发送 RDP 响应帧失败")?;
                    }
                }
                ActiveStageOutput::GraphicsUpdate(rect) => send_frame(on_frame, image, &rect)?,
                ActiveStageOutput::Terminate(reason) => return Ok(Some(reason.description())),
                ActiveStageOutput::DeactivateAll => {
                    // 后续批次：动态分辨率需要重建 ActiveStage；当前忽略，等待服务器推新画面。
                    log::debug!("RDP 服务器请求重新激活会话，当前版本暂不处理分辨率变化");
                }
                _ => {}
            }
        }
        Ok(None)
    }

    /// 把前端鼠标状态翻译为 FastPath 输入事件（按钮 + 滚轮 + 移动）。
    fn input_events(
        database: &mut Database,
        previous_mask: &mut u8,
        input: RdpInput,
    ) -> Vec<FastPathInputEvent> {
        match input {
            RdpInput::Pointer { mask, x, y } => {
                // 先移动再按键，保证按下时的坐标是正确的。
                let mut operations = vec![Operation::MouseMove(MousePosition { x, y })];
                for (bit, button) in [
                    (0x01u8, MouseButton::Left),
                    (0x02, MouseButton::Middle),
                    (0x04, MouseButton::Right),
                ] {
                    let was_pressed = (*previous_mask & bit) != 0;
                    let is_pressed = (mask & bit) != 0;
                    if was_pressed != is_pressed {
                        operations.push(if is_pressed {
                            Operation::MouseButtonPressed(button)
                        } else {
                            Operation::MouseButtonReleased(button)
                        });
                    }
                }
                // VNC 风格的滚轮位：8 = 上滚，16 = 下滚，每次事件只发一次。
                if (mask & 0x08) != 0 {
                    operations.push(Operation::WheelRotations(WheelRotations {
                        is_vertical: true,
                        rotation_units: 1,
                    }));
                }
                if (mask & 0x10) != 0 {
                    operations.push(Operation::WheelRotations(WheelRotations {
                        is_vertical: true,
                        rotation_units: -1,
                    }));
                }
                *previous_mask = mask & 0x07;
                database.apply(operations).into_iter().collect()
            }
            RdpInput::Key { down, scancode } => {
                let scancode = Scancode::from_u16(scancode);
                let operation = if down {
                    Operation::KeyPressed(scancode)
                } else {
                    Operation::KeyReleased(scancode)
                };
                database.apply([operation]).into_iter().collect()
            }
            RdpInput::Close => Vec::new(),
        }
    }

    fn send_frame(
        on_frame: &TauriChannel<InvokeResponseBody>,
        image: &DecodedImage,
        rect: &InclusiveRectangle,
    ) -> Result<()> {
        let width = rect.width();
        let height = rect.height();
        if width == 0 || height == 0 {
            return Ok(());
        }
        if usize::from(rect.right) >= usize::from(image.width())
            || usize::from(rect.bottom) >= usize::from(image.height())
        {
            bail!("RDP 画面脏区超出缓冲区");
        }

        let stride = image.stride();
        let data = image.data();
        let mut payload = Vec::with_capacity(8 + width as usize * height as usize * 4);
        payload.extend_from_slice(&rect.left.to_be_bytes());
        payload.extend_from_slice(&rect.top.to_be_bytes());
        payload.extend_from_slice(&width.to_be_bytes());
        payload.extend_from_slice(&height.to_be_bytes());
        for row in 0..usize::from(height) {
            let start = (usize::from(rect.top) + row) * stride + usize::from(rect.left) * 4;
            let end = start + usize::from(width) * 4;
            if end > data.len() {
                bail!("RDP 画面块超出缓冲区");
            }
            payload.extend_from_slice(&data[start..end]);
        }
        on_frame
            .send(InvokeResponseBody::Raw(payload))
            .map_err(|error| anyhow!("发送 RDP 画面帧失败：{error}"))
    }

    fn to_app_error(error: anyhow::Error) -> AppError {
        let text = format!("{error:#}");
        let lower = text.to_lowercase();
        let (code, retryable) = if lower.contains("status_logon_failure")
            || lower.contains("logon failure")
            || lower.contains("access denied")
            || lower.contains("credssp")
            || lower.contains("authentication")
        {
            ("rdp.auth_failed", false)
        } else if lower.contains("connection refused") {
            ("rdp.tcp_refused", true)
        } else if lower.contains("failed to lookup")
            || lower.contains("name or service not known")
            || lower.contains("nodename nor servname")
            || lower.contains("no such host")
        {
            ("rdp.dns_failed", false)
        } else if lower.contains("超时") || lower.contains("timed out") {
            ("rdp.timeout", true)
        } else {
            ("rdp.connect_failed", true)
        };
        AppError::new(code, text).retryable(retryable)
    }
}

pub use embedded::RdpManager;
