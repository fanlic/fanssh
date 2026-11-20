use std::collections::HashSet;
use std::path::PathBuf;
use tauri::ipc::Channel as TauriChannel;
use tauri::State;
use uuid::Uuid;

use crate::ai;
use crate::app::settings::{AiSettingsFile, UiSettings};
use crate::app::AppState;
use crate::docker::{self, DockerContainer, DockerLogs};
use crate::ipc::dto::{
    AiChatRequest, AiSettingsInput, AiSettingsView, Nl2CmdResult, RdpEvent,
    RdpInputDto, RemoteEntry, SerialPortInfo, SftpOpResult, SftpOpenResp, SftpTextFile,
    TermEvent, TransferEvent, UpdateEvent, UpdateInfoDto, UpdaterStatusDto, VncEvent, VncInputDto,
};
use crate::ipc::error::{AppError, AppResult};
use crate::monitor::MonitorEvent;
use crate::profile::ImportError;
use crate::serial::SerialManager;
use crate::session::model::{AuthRef, Profile, Protocol, SecretKind, SessionId};
use crate::vault::SecretRef;

// ---------------------------------------------------------------------------
// 终端
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn term_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
    on_event: TauriChannel<TermEvent>,
) -> AppResult<SessionId> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "服务器配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Ssh) {
        return Err(AppError::new(
            "ssh.unsupported",
            "该配置不是 SSH 协议，无法打开终端",
        ));
    }
    let vault = state.vault.clone();
    state.ssh.open(profile, vault, on_event).await
}

#[tauri::command]
pub async fn term_input(
    state: State<'_, AppState>,
    session: SessionId,
    bytes: Vec<u8>,
) -> AppResult<()> {
    state.ssh.write(session, bytes).await
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    session: SessionId,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    state.ssh.resize(session, cols, rows).await
}

#[tauri::command]
pub async fn term_close(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.ssh.close(session).await
}

/// 键盘交互认证：提交用户输入；responses 为 None 表示用户取消。
#[tauri::command]
pub async fn term_auth_respond(
    state: State<'_, AppState>,
    prompt_id: Uuid,
    responses: Option<Vec<String>>,
) -> AppResult<()> {
    state.ssh.respond_auth(prompt_id, responses).await
}

/// 读取用户通过文件对话框选择的本地私钥。限制大小，避免误选大文件。
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    let path = PathBuf::from(path);
    let meta = std::fs::metadata(&path)
        .map_err(|e| AppError::new("file.read_failed", format!("读取文件失败：{e}")))?;
    if !meta.is_file() {
        return Err(AppError::new("file.not_file", "所选路径不是文件"));
    }
    if meta.len() > 2 * 1024 * 1024 {
        return Err(AppError::new("file.too_large", "文件超过 2 MB，已拒绝读取"));
    }
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::new("file.read_failed", format!("读取文件失败：{e}")))
}

// ---------------------------------------------------------------------------
// Docker（复用当前 SSH 连接，经 docker.sock 转发）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn docker_containers(
    state: State<'_, AppState>,
    session: SessionId,
) -> AppResult<Vec<DockerContainer>> {
    docker::containers(&state.ssh, session).await
}

#[tauri::command]
pub async fn docker_logs(
    state: State<'_, AppState>,
    session: SessionId,
    container: String,
    tail: Option<u32>,
) -> AppResult<DockerLogs> {
    docker::logs(&state.ssh, session, &container, tail.unwrap_or(500)).await
}

// ---------------------------------------------------------------------------
// 服务器监控（只读 /proc 采样，不在远端写文件）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn monitor_start(
    state: State<'_, AppState>,
    session: SessionId,
    on_event: TauriChannel<MonitorEvent>,
) -> AppResult<()> {
    state
        .monitor
        .start(state.ssh.clone(), session, on_event)
        .await
}

#[tauri::command]
pub async fn monitor_stop(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.monitor.stop(session).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// 串口
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn serial_list_ports() -> AppResult<Vec<SerialPortInfo>> {
    SerialManager::list_ports()
}

#[tauri::command]
pub async fn serial_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
    on_event: TauriChannel<TermEvent>,
) -> AppResult<SessionId> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "服务器配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Serial) {
        return Err(AppError::new(
            "serial.invalid_profile",
            "该配置不是串口协议，无法打开串口终端",
        ));
    }
    state.serial.open(profile, on_event)
}

#[tauri::command]
pub async fn serial_input(
    state: State<'_, AppState>,
    session: SessionId,
    bytes: Vec<u8>,
) -> AppResult<()> {
    state.serial.write(session, bytes)
}

/// 运行中切换 DTR / RTS；部分交换机 console 需要 DTR 有效才有输出。
#[tauri::command]
pub async fn serial_set_lines(
    state: State<'_, AppState>,
    session: SessionId,
    dtr: bool,
    rts: bool,
) -> AppResult<()> {
    state.serial.set_lines(session, dtr, rts)
}

#[tauri::command]
pub async fn serial_close(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.serial.close(session)
}

// ---------------------------------------------------------------------------
// Telnet
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn telnet_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
    on_event: TauriChannel<TermEvent>,
) -> AppResult<SessionId> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "服务器配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Telnet) {
        return Err(AppError::new(
            "telnet.invalid_profile",
            "该配置不是 Telnet 协议，无法打开终端",
        ));
    }
    let vault = state.vault.clone();
    state.telnet.open(profile, vault, on_event).await
}

#[tauri::command]
pub async fn telnet_input(
    state: State<'_, AppState>,
    session: SessionId,
    bytes: Vec<u8>,
) -> AppResult<()> {
    state.telnet.write(session, bytes).await
}

#[tauri::command]
pub async fn telnet_close(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.telnet.close(session).await
}

// ---------------------------------------------------------------------------
// VNC
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vnc_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
    on_event: TauriChannel<VncEvent>,
    on_frame: TauriChannel<tauri::ipc::InvokeResponseBody>,
) -> AppResult<SessionId> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "VNC 配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Vnc) {
        return Err(AppError::new(
            "vnc.invalid_profile",
            "该配置不是 VNC 协议，无法打开画面",
        ));
    }
    let vault = state.vault.clone();
    state.vnc.open(profile, vault, on_event, on_frame).await
}

#[tauri::command]
pub async fn vnc_input(
    state: State<'_, AppState>,
    session: SessionId,
    input: VncInputDto,
) -> AppResult<()> {
    state.vnc.input(session, input).await
}

#[tauri::command]
pub async fn vnc_close(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.vnc.close(session).await
}

// ---------------------------------------------------------------------------
// 服务器配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn profile_list(state: State<'_, AppState>) -> AppResult<Vec<Profile>> {
    Ok(state.profiles.list())
}

#[tauri::command]
pub async fn profile_upsert(state: State<'_, AppState>, profile: Profile) -> AppResult<Profile> {
    state
        .profiles
        .upsert(profile)
        .map_err(|e| AppError::new("profile.invalid", format!("{e:#}")))
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    let removed = state
        .profiles
        .delete(&id)
        .map_err(|e| AppError::new("profile.invalid", format!("{e:#}")))?;
    if let Some(profile) = removed {
        let referenced: HashSet<Uuid> = state
            .profiles
            .list()
            .iter()
            .flat_map(|p| p.secret_ids())
            .collect();
        for secret_id in profile.secret_ids() {
            if !referenced.contains(&secret_id) {
                let _ = state.vault.delete(&secret_id);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn profile_export(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<usize> {
    state
        .profiles
        .export(&PathBuf::from(path), &passphrase, &state.vault)
        .map_err(|e| AppError::new("profile.export_failed", format!("{e:#}")))
}

#[tauri::command]
pub async fn profile_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: Option<String>,
) -> AppResult<usize> {
    match state
        .profiles
        .import(&PathBuf::from(path), passphrase.as_deref(), &state.vault)
    {
        Ok(count) => Ok(count),
        Err(ImportError::PassphraseRequired) => Err(AppError::new(
            "profile.passphrase_required",
            "该文件已加密，请输入导出口令",
        )),
        Err(ImportError::BadPassphrase) => Err(AppError::new(
            "profile.bad_passphrase",
            "口令错误或文件已损坏",
        )),
        Err(ImportError::Failed(error)) => {
            Err(AppError::new("profile.import_failed", format!("{error:#}")))
        }
    }
}

// ---------------------------------------------------------------------------
// 凭据库
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn vault_put(
    state: State<'_, AppState>,
    id: Option<Uuid>,
    kind: SecretKind,
    label: String,
    plaintext: String,
) -> AppResult<Uuid> {
    if plaintext.is_empty() {
        return Err(AppError::new("vault.empty_secret", "凭据内容不能为空"));
    }
    let label = if label.trim().is_empty() {
        kind.as_str().to_string()
    } else {
        label
    };
    state
        .vault
        .put(id, kind, &label, &plaintext)
        .map_err(|e| AppError::new("vault.encrypt_failed", format!("{e:#}")))
}

#[tauri::command]
pub async fn vault_list(state: State<'_, AppState>) -> AppResult<Vec<SecretRef>> {
    Ok(state.vault.list())
}

#[tauri::command]
pub async fn vault_delete(state: State<'_, AppState>, id: Uuid) -> AppResult<()> {
    state
        .vault
        .delete(&id)
        .map_err(|e| AppError::new("vault.delete_failed", format!("{e:#}")))
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
) -> AppResult<SftpOpenResp> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "服务器配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Ssh) {
        return Err(AppError::new("sftp.unsupported", "SFTP 需要 SSH 协议配置"));
    }
    let vault = state.vault.clone();
    let sftp = state.sftp.clone();
    let (sftp_id, home) = sftp.open(&profile, &vault).await?;
    Ok(SftpOpenResp { sftp_id, home })
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    path: String,
) -> AppResult<Vec<RemoteEntry>> {
    let sftp = state.sftp.clone();
    sftp.list(sftp_id, &path).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    path: String,
    mode: u32,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.chmod(sftp_id, &path, mode).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    local_paths: Vec<String>,
    remote_dir: String,
    conflict: String,
    restart: bool,
    on_event: TauriChannel<TransferEvent>,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.upload(
        sftp_id,
        local_paths,
        remote_dir,
        conflict,
        restart,
        on_event,
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    remote_path: String,
    local_path: String,
    conflict: String,
    restart: bool,
    on_event: TauriChannel<TransferEvent>,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.download(
        sftp_id,
        remote_path,
        local_path,
        conflict,
        restart,
        on_event,
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    from: String,
    to: String,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.rename(sftp_id, &from, &to)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, sftp_id: Uuid, path: String) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.mkdir(sftp_id, &path).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    paths: Vec<String>,
) -> AppResult<Vec<SftpOpResult>> {
    let sftp = state.sftp.clone();
    sftp.remove_many(sftp_id, paths)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    path: String,
) -> AppResult<SftpTextFile> {
    let sftp = state.sftp.clone();
    sftp.read_text(sftp_id, &path)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    path: String,
    content: String,
    expected_mtime: Option<u32>,
) -> AppResult<SftpTextFile> {
    let sftp = state.sftp.clone();
    sftp.write_text(sftp_id, &path, &content, expected_mtime)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_local_exists(path: String) -> AppResult<bool> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, sftp_id: Uuid) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.close(sftp_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_settings_get(state: State<'_, AppState>) -> AppResult<AiSettingsView> {
    Ok(to_view(state.settings.ai(), &*state))
}

#[tauri::command]
pub async fn ai_settings_save(
    state: State<'_, AppState>,
    settings: AiSettingsInput,
) -> AppResult<AiSettingsView> {
    let provider = settings.provider.trim().to_lowercase();
    if provider != "openai" && provider != "ollama" {
        return Err(AppError::new(
            "ai.invalid_settings",
            "provider 只能是 openai（OpenAI 兼容）或 ollama",
        ));
    }
    if settings.base_url.trim().is_empty() {
        return Err(AppError::new("ai.invalid_settings", "Base URL 不能为空"));
    }
    if settings.model.trim().is_empty() {
        return Err(AppError::new("ai.invalid_settings", "模型名称不能为空"));
    }
    if let Some(secret_id) = settings.secret_id {
        if !state.vault.contains(&secret_id) {
            return Err(AppError::new(
                "vault.not_found",
                "API Key 凭据不存在，请重新保存",
            ));
        }
    }

    let file = AiSettingsFile {
        provider,
        base_url: settings.base_url.trim().trim_end_matches('/').to_string(),
        model: settings.model.trim().to_string(),
        temperature: settings.temperature.clamp(0.0, 2.0),
        secret_id: settings.secret_id,
        max_context_kb: settings.max_context_kb.clamp(1, 128),
    };
    let saved = state
        .settings
        .save_ai(file)
        .map_err(|e| AppError::new("ai.save_failed", format!("{e:#}")))?;
    Ok(to_view(saved, &*state))
}

// ---------------------------------------------------------------------------
// 界面设置（主题 / 终端 / 快捷键）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ui_settings_get(state: State<'_, AppState>) -> AppResult<UiSettings> {
    Ok(state.settings.ui())
}

#[tauri::command]
pub async fn ui_settings_save(
    state: State<'_, AppState>,
    settings: UiSettings,
) -> AppResult<UiSettings> {
    let mut settings = settings;
    // 后端做边界约束，避免前端写入极端值破坏终端渲染。
    settings.terminal.font_size = settings.terminal.font_size.clamp(10, 32);
    settings.terminal.line_height = settings.terminal.line_height.clamp(0.8, 2.0);
    settings.terminal.letter_spacing = settings.terminal.letter_spacing.clamp(-2.0, 6.0);
    settings.terminal.scrollback = settings.terminal.scrollback.clamp(100, 100_000);
    if !matches!(
        settings.terminal.cursor_style.as_str(),
        "bar" | "block" | "underline"
    ) {
        settings.terminal.cursor_style = "bar".to_string();
    }
    if !matches!(
        settings.terminal.inactive_cursor_style.as_str(),
        "none" | "outline" | "block" | "bar" | "underline"
    ) {
        settings.terminal.inactive_cursor_style = "none".to_string();
    }
    if !matches!(settings.terminal.right_click.as_str(), "menu" | "paste") {
        settings.terminal.right_click = "menu".to_string();
    }
    state
        .settings
        .save_ui(settings)
        .map_err(|e| AppError::new("ui.save_failed", format!("{e:#}")))
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    request: AiChatRequest,
) -> AppResult<String> {
    let settings = state.settings.ai();
    let api_key = read_api_key(&*state, &settings)?;
    let api_key = api_key.as_ref().map(|key| key.as_str());
    let system = match request.kind.as_str() {
        "explain" => ai::prompt::EXPLAIN_SYSTEM,
        _ => ai::prompt::CHAT_SYSTEM,
    };
    ai::chat(
        &state.http,
        &settings,
        api_key,
        system,
        request.messages,
        request.context.as_deref(),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn ai_nl2cmd(
    state: State<'_, AppState>,
    prompt: String,
    context: Option<String>,
) -> AppResult<Nl2CmdResult> {
    if prompt.trim().is_empty() {
        return Err(AppError::new("ai.empty_prompt", "请先输入需求描述"));
    }
    let settings = state.settings.ai();
    let api_key = read_api_key(&*state, &settings)?;
    let api_key = api_key.as_ref().map(|key| key.as_str());
    let messages = ai::build_nl2cmd_messages(&prompt, context.as_deref());
    let raw = ai::complete(
        &state.http,
        &settings,
        api_key,
        ai::prompt::NL2CMD_SYSTEM,
        messages,
    )
    .await?;

    let result = ai::parse_nl2cmd(&raw);
    if result.command.trim().is_empty() {
        return Err(AppError::new(
            "ai.invalid_response",
            "模型没有返回可执行的命令",
        )
        .with_detail(raw));
    }
    Ok(result)
}

fn to_view(settings: AiSettingsFile, state: &AppState) -> AiSettingsView {
    // 仅展示是否存在凭据，绝不把明文密钥返回前端

    let has_key = settings
        .secret_id
        .map(|id| state.vault.contains(&id))
        .unwrap_or(false);
    AiSettingsView {
        provider: settings.provider,
        base_url: settings.base_url,
        model: settings.model,
        temperature: settings.temperature,
        secret_id: settings.secret_id,
        max_context_kb: settings.max_context_kb,
        has_key,
    }
}

fn read_api_key(
    state: &AppState,
    settings: &AiSettingsFile,
) -> AppResult<Option<zeroize::Zeroizing<String>>> {
    match settings.secret_id {
        Some(id) => Ok(Some(state.vault.get(&id)?)),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// RDP
// ---------------------------------------------------------------------------

/// 打开内嵌 RDP 会话（Windows / Linux 共用）。密码优先使用本次一次性输入，其次从 vault 解密；
/// 两者都没有时返回 rdp.password_required，由前端弹一次性密码框后重试。
#[tauri::command]
pub async fn rdp_open(
    state: State<'_, AppState>,
    profile_id: Uuid,
    password: Option<String>,
    on_event: TauriChannel<RdpEvent>,
    on_frame: TauriChannel<tauri::ipc::InvokeResponseBody>,
) -> AppResult<SessionId> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "RDP 配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Rdp) {
        return Err(AppError::new(
            "rdp.invalid_profile",
            "该配置不是 RDP 协议，无法打开远程桌面",
        ));
    }
    let vault = state.vault.clone();
    state
        .rdp
        .open(profile, vault, password, on_event, on_frame)
        .await
}

#[tauri::command]
pub async fn rdp_input(
    state: State<'_, AppState>,
    session: SessionId,
    input: RdpInputDto,
) -> AppResult<()> {
    state.rdp.input(session, input).await
}

#[tauri::command]
pub async fn rdp_close(state: State<'_, AppState>, session: SessionId) -> AppResult<()> {
    state.rdp.close(session).await
}

// ---------------------------------------------------------------------------
// 端口转发 / 隧道
// ---------------------------------------------------------------------------

/// 启动一条转发路由。路由由后端从配置中按 id 取出，前端不能注入任意目标。
#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    profile_id: Uuid,
    route_id: Uuid,
    on_event: TauriChannel<crate::ipc::dto::TunnelEvent>,
) -> AppResult<()> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "隧道配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Tunnel) {
        return Err(AppError::new(
            "tunnel.invalid_profile",
            "该配置不是隧道协议",
        ));
    }
    let prefs = profile.tunnel_prefs();
    let server_id = prefs
        .server_id
        .ok_or_else(|| AppError::new("tunnel.server_missing", "隧道还没有选择 SSH 服务器"))?;
    let server = state.profiles.get(&server_id).ok_or_else(|| {
        AppError::new(
            "tunnel.server_missing",
            "隧道绑定的 SSH 服务器已被删除，请重新选择服务器",
        )
    })?;
    let route = prefs
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .cloned()
        .ok_or_else(|| AppError::new("tunnel.route_missing", "找不到该转发路由"))?;
    let vault = state.vault.clone();
    state
        .tunnel
        .start(&profile, server, vault, route, on_event)
        .await
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, route_id: Uuid) -> AppResult<()> {
    state.tunnel.stop(route_id).await
}

#[tauri::command]
pub async fn tunnel_active(state: State<'_, AppState>) -> AppResult<Vec<Uuid>> {
    Ok(state.tunnel.active().await)
}

// ---------------------------------------------------------------------------
// 自动更新
// ---------------------------------------------------------------------------

/// 更新源地址来自 tauri.conf.json 的 plugins.updater.endpoints，
/// 不在代码里写死；改地址只需改配置或按 README 用构建期变量覆盖。
fn configured_endpoint(app: &tauri::AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("endpoints"))
        .and_then(|value| value.as_array())
        .and_then(|list| list.first())
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

/// 把 latest.json 的地址还原成更新通道的 Releases 页面，供便携版提示下载。
fn channel_url(endpoint: &str) -> String {
    match endpoint.split("/releases/").next() {
        Some(base) if !base.is_empty() && base.len() < endpoint.len() => format!("{base}/releases"),
        _ => endpoint.to_string(),
    }
}

/// 便携版（exe 同级存在 portable.marker）不做自更新，只提示下载新的 zip。
fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("portable.marker").exists()))
        .unwrap_or(false)
}

/// 是否运行在 AppImage 内。AppImage 运行时由运行时注入 APPIMAGE（镜像路径）与 APPDIR。
/// deb 安装后直接执行 /usr/bin 下的可执行文件，这两个变量都不存在。
fn running_in_appimage() -> bool {
    std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some()
}

/// 运行时形态。Linux 下只有 AppImage 能就地替换镜像；deb 安装需要用户重新安装。
fn update_runtime() -> &'static str {
    if is_portable() {
        return "portable";
    }
    match std::env::consts::OS {
        "windows" => "windows",
        "linux" => {
            if running_in_appimage() {
                "appimage"
            } else {
                "deb"
            }
        }
        "macos" => "macos",
        _ => "other",
    }
}

/// 支持应用内自更新的运行时：Windows 安装版（NSIS）与 Linux AppImage。
fn supports_self_update(runtime: &str) -> bool {
    matches!(runtime, "windows" | "appimage")
}

/// deb 安装版不替换镜像，但允许检查版本并引导用户去更新通道下载新 deb。
fn supports_update_check(runtime: &str) -> bool {
    supports_self_update(runtime) || runtime == "deb"
}

fn build_updater(app: &tauri::AppHandle) -> AppResult<tauri_plugin_updater::Updater> {
    use tauri_plugin_updater::UpdaterExt;

    app.updater().map_err(|e| {
        AppError::new(
            "updater.config",
            format!("更新器初始化失败：{e}（请确认 tauri.conf.json 中 plugins.updater 的 pubkey 与 endpoints 已配置）"),
        )
    })
}

/// 当前构建平台（windows / linux / macos），供前端隐藏或提示平台不支持的能力。
#[tauri::command]
pub fn app_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn updater_status(app: tauri::AppHandle) -> AppResult<UpdaterStatusDto> {
    let endpoint = configured_endpoint(&app).unwrap_or_default();
    let runtime = update_runtime();
    Ok(UpdaterStatusDto {
        current_version: app.package_info().version.to_string(),
        channel_url: channel_url(&endpoint),
        endpoint,
        portable: is_portable(),
        runtime: runtime.to_string(),
        self_update: supports_self_update(runtime),
    })
}

#[tauri::command]
pub async fn updater_check(app: tauri::AppHandle) -> AppResult<Option<UpdateInfoDto>> {
    let runtime = update_runtime();
    if runtime == "portable" {
        return Err(AppError::new(
            "updater.portable",
            "便携版不支持自动更新，请到 Release 页面下载新的便携 zip",
        ));
    }
    if !supports_update_check(runtime) {
        return Err(AppError::new(
            "updater.unsupported",
            "当前平台不支持自动更新，请到 Release 页面下载新版本",
        ));
    }
    let updater = build_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| AppError::new("updater.check_failed", format!("检查更新失败：{e}")))?;
    let self_update = supports_self_update(runtime);
    let fallback_url = channel_url(&configured_endpoint(&app).unwrap_or_default());
    Ok(update.map(|update| UpdateInfoDto {
        version: update.version.to_string(),
        current_version: update.current_version.to_string(),
        notes: update.body.clone(),
        date: update.date.as_ref().map(|date| date.to_string()),
        // 能自更新的运行时给出安装包直链；deb 安装版给更新通道页面，由用户挑选 deb 重新安装
        url: Some(if self_update {
            update.download_url.to_string()
        } else {
            fallback_url
        }),
    }))
}

#[tauri::command]
pub async fn updater_install(
    app: tauri::AppHandle,
    on_event: TauriChannel<UpdateEvent>,
) -> AppResult<()> {
    match update_runtime() {
        "portable" => {
            return Err(AppError::new(
                "updater.portable",
                "便携版不支持自动更新，请到 Release 页面下载新的便携 zip",
            ))
        }
        "deb" => {
            return Err(AppError::new(
                "updater.deb_install",
                "deb 安装版不支持应用内自更新，请下载新版本后重新安装 deb",
            ))
        }
        runtime if !supports_self_update(runtime) => {
            return Err(AppError::new(
                "updater.unsupported",
                "当前平台不支持应用内自动更新，请到 Release 页面下载新版本",
            ))
        }
        _ => {}
    }
    let updater = build_updater(&app)?;

    let update = updater
        .check()
        .await
        .map_err(|e| AppError::new("updater.check_failed", format!("检查更新失败：{e}")))?
        .ok_or_else(|| AppError::new("updater.none", "当前已是最新版本"))?;

    let channel = on_event.clone();
    let _ = on_event.send(UpdateEvent::Downloading);
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    update
        .download_and_install(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk as u64;
                if last_emit.elapsed().as_millis() >= 120 {
                    last_emit = std::time::Instant::now();
                    let _ = channel.send(UpdateEvent::Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| AppError::new("updater.install_failed", format!("下载或安装失败：{e}")))?;
    let _ = on_event.send(UpdateEvent::Installed);
    Ok(())
}

/// 用系统默认浏览器打开外链，只放行 http/https。
/// 直接启动系统 opener 进程，不经过 shell，避免把 URL 拼进命令行被解释。
#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| AppError::new("external.invalid_url", "链接格式不正确"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            "external.scheme",
            "只允许打开 http/https 链接",
        ));
    }
    let target = parsed.as_str().to_string();
    #[cfg(target_os = "linux")]
    let (program, args) = ("xdg-open", vec![target.clone()]);
    #[cfg(target_os = "windows")]
    let (program, args) = (
        "rundll32.exe",
        vec!["url.dll,FileProtocolHandler".to_string(), target.clone()],
    );
    #[cfg(target_os = "macos")]
    let (program, args) = ("open", vec![target.clone()]);
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let (program, args) = ("xdg-open", vec![target.clone()]);

    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::new("external.spawn_failed", format!("打开链接失败：{e}")))
}
