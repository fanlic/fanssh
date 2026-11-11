use anyhow::Context;
use std::path::Path;

use crate::ipc::dto::RdpHandleDto;
use crate::ipc::error::{AppError, AppResult};
use crate::session::model::Profile;

/// 生成 .rdp 文件并调用 Windows 自带 mstsc.exe。
///
/// 密码两条约束：
/// 1. 不进命令行（mstsc 不支持，且会出现在进程列表里）；
/// 2. 不写进 .rdp（明文落盘）。
///
/// 因此密码通过 Windows 凭据管理器交给 mstsc：以 `TERMSRV/<host>` 为 target 写一条
/// generic 凭据，mstsc 启动后会直接取用。调用方传入的密码来自 vault 解密结果，
/// 只在本进程内存里短暂存在。
pub fn launch(profile: &Profile, password: Option<&str>, data_dir: &Path) -> AppResult<RdpHandleDto> {
    if !cfg!(windows) {
        return Err(AppError::new(
            "rdp.unsupported",
            "RDP 仅支持 Windows 平台（需要 mstsc.exe）；当前系统无法验证该功能",
        ));
    }

    let prefs = profile.rdp_prefs();
    let port = profile.target.port;
    let address = if port == 3389 {
        profile.target.host.clone()
    } else {
        format!("{}:{}", profile.target.host, port)
    };
    let login_user = login_user(profile);

    if let Some(secret) = password.filter(|value| !value.is_empty()) {
        if login_user.is_empty() {
            // 没有用户名时凭据管理器无法定位到具体账户，交给 mstsc 自己弹输入框。
            return Err(AppError::new(
                "rdp.user_required",
                "填写密码时必须同时填写用户名，否则无法写入 Windows 凭据",
            ));
        }
        write_credential(&profile.target.host, port, &login_user, secret).map_err(|e| {
            AppError::new(
                "rdp.credential_failed",
                format!("写入 Windows 凭据管理器失败：{e}。可留空密码，由 mstsc 弹窗手动输入"),
            )
        })?;
    }

    let mut content = String::new();
    content.push_str(&format!(
        "screen mode id:i:{}\n",
        if prefs.fullscreen { 2 } else { 1 }
    ));
    content.push_str(&format!("use multimon:i:{}\n", if prefs.multimon { 1 } else { 0 }));
    content.push_str(&format!("desktopwidth:i:{}\n", prefs.width.max(800)));
    content.push_str(&format!("desktopheight:i:{}\n", prefs.height.max(600)));
    content.push_str("session bpp:i:32\n");
    content.push_str("compression:i:1\n");
    content.push_str("keyboardhook:i:2\n");
    content.push_str("audiomode:i:0\n");
    content.push_str("authentication level:i:2\n");
    content.push_str("prompt for credentials:i:1\n");
    content.push_str("negotiate security layer:i:1\n");
    content.push_str(&format!(
        "redirectclipboard:i:{}\n",
        if prefs.clipboard { 1 } else { 0 }
    ));
    content.push_str(&format!("full address:s:{address}\n"));
    if !login_user.is_empty() {
        content.push_str(&format!("username:s:{login_user}\n"));
    }
    if prefs.drive_redirect {
        content.push_str("drivestoredirect:s:*\n");
    }
    if prefs.admin_session {
        content.push_str("administrative session:i:1\n");
    }
    if let Some(gateway) = prefs.gateway.as_ref().filter(|g| !g.trim().is_empty()) {
        content.push_str(&format!("gatewayhostname:s:{gateway}\n"));
        content.push_str("gatewayusagemethod:i:1\n");
    }

    let rdp_dir = data_dir.join("rdp");
    std::fs::create_dir_all(&rdp_dir).context("创建 RDP 配置目录失败")?;
    let path = rdp_dir.join(format!("{}.rdp", profile.id));
    std::fs::write(&path, content).context("写入 .rdp 文件失败")?;

    spawn_mstsc(&path).map_err(|e| {
        AppError::new(
            "rdp.mstsc_missing",
            format!("启动 mstsc.exe 失败：{e}。请确认当前系统为 Windows 且包含远程桌面客户端"),
        )
    })?;

    Ok(RdpHandleDto {
        pid: None,
        rdp_file: path.display().to_string(),
    })
}

/// 组装登录名：有域时按 `DOMAIN\user`，没有则用原始用户名。
/// 已自带 `\` 或 `@`（UPN）时保持用户输入不变。
fn login_user(profile: &Profile) -> String {
    let user = profile.target.user.trim();
    if user.is_empty() {
        return String::new();
    }
    if user.contains('\\') || user.contains('@') {
        return user.to_string();
    }
    match profile.rdp_prefs().domain {
        Some(domain) if !domain.trim().is_empty() => {
            format!("{}\\{}", domain.trim(), user)
        }
        _ => user.to_string(),
    }
}

/// 写入 Windows 凭据管理器（generic）。
///
/// 取舍：连接结束后**不**删除这条凭据。删除会让系统下次免密登录失效，
/// 用户每次都要重新输入密码；凭据按当前 Windows 账户持久化
/// （CRED_PERSIST_LOCAL_MACHINE），属于"用户主动保存密码"的语义，
/// 因此保留。需要清理时可在「控制面板 → 凭据管理器 → Windows 凭据」
/// 里删除 `TERMSRV/<host>`。
#[cfg(windows)]
fn write_credential(host: &str, port: u16, user: &str, password: &str) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let mut target = wide(&format!("TERMSRV/{host}"));
    let mut alias_target = if port == 3389 {
        Vec::new()
    } else {
        // 非默认端口时 mstsc 会用 "TERMSRV/host:port" 查找，两个 target 都写，避免取不到。
        wide(&format!("TERMSRV/{host}:{port}"))
    };
    let mut user_w = wide(user);
    // 凭据 blob 用 UTF-16LE，Windows 凭据管理器按此解析域账户密码。
    let mut blob: Vec<u8> = password.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();

    let mut cred: CREDENTIALW = unsafe { std::mem::zeroed() };
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = target.as_mut_ptr();
    cred.CredentialBlobSize = blob.len() as u32;
    cred.CredentialBlob = blob.as_mut_ptr();
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
    cred.UserName = user_w.as_mut_ptr();
    let ok = unsafe { CredWriteW(&cred, 0) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }

    if !alias_target.is_empty() {
        let mut alias: CREDENTIALW = unsafe { std::mem::zeroed() };
        alias.Type = CRED_TYPE_GENERIC;
        alias.TargetName = alias_target.as_mut_ptr();
        alias.CredentialBlobSize = blob.len() as u32;
        alias.CredentialBlob = blob.as_mut_ptr();
        alias.Persist = CRED_PERSIST_LOCAL_MACHINE;
        alias.UserName = user_w.as_mut_ptr();
        // 别名写失败不影响主 target，mstsc 仍可回退到 TERMSRV/<host>。
        unsafe { CredWriteW(&alias, 0) };
    }

    Ok(())
}

#[cfg(not(windows))]
fn write_credential(_host: &str, _port: u16, _user: &str, _password: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "RDP 仅支持 Windows",
    ))
}

#[cfg(windows)]
fn spawn_mstsc(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("mstsc.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn spawn_mstsc(_path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "RDP 仅支持 Windows",
    ))
}
