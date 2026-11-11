use std::collections::HashSet;
use std::path::PathBuf;
use tauri::ipc::Channel as TauriChannel;
use tauri::State;
use uuid::Uuid;

use crate::ai;
use crate::app::settings::AiSettingsFile;
use crate::app::AppState;
use crate::ipc::dto::{
    AiChatRequest, AiSettingsInput, AiSettingsView, Nl2CmdResult, RdpHandleDto, RemoteEntry,
    SftpOpenResp, TermEvent, TransferEvent,
};
use crate::ipc::error::{AppError, AppResult};
use crate::session::model::{Profile, Protocol, SecretKind, SessionId};
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
pub async fn profile_export(state: State<'_, AppState>, path: String) -> AppResult<usize> {
    state
        .profiles
        .export(&PathBuf::from(path))
        .map_err(|e| AppError::new("profile.export_failed", format!("{e:#}")))
}

#[tauri::command]
pub async fn profile_import(state: State<'_, AppState>, path: String) -> AppResult<usize> {
    state
        .profiles
        .import(&PathBuf::from(path))
        .map_err(|e| AppError::new("profile.import_failed", format!("{e:#}")))
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
    on_event: TauriChannel<TransferEvent>,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.upload(sftp_id, local_paths, remote_dir, on_event)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    sftp_id: Uuid,
    remote_path: String,
    local_path: String,
    on_event: TauriChannel<TransferEvent>,
) -> AppResult<()> {
    let sftp = state.sftp.clone();
    sftp.download(sftp_id, remote_path, local_path, on_event)
        .await
        .map_err(AppError::from)
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

#[tauri::command]
pub async fn rdp_launch(
    state: State<'_, AppState>,
    profile_id: Uuid,
) -> AppResult<RdpHandleDto> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AppError::new("profile.not_found", "服务器配置不存在"))?;
    if !matches!(profile.protocol, Protocol::Rdp) {
        return Err(AppError::new(
            "rdp.invalid_profile",
            "该配置不是 RDP 协议，请先在配置中选择 RDP",
        ));
    }
    crate::transport::rdp::launch(&profile, &state.data_dir)
}
