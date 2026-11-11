use anyhow::Context;
use std::path::Path;

use crate::ipc::dto::RdpHandleDto;
use crate::ipc::error::{AppError, AppResult};
use crate::session::model::Profile;

/// 生成 .rdp 文件并调用 Windows 自带 mstsc.exe。
/// 密码不经命令行传递（mstsc 不支持安全地传密码），首次连接由系统凭据提示接管。
pub fn launch(profile: &Profile, data_dir: &Path) -> AppResult<RdpHandleDto> {
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
    if !profile.target.user.trim().is_empty() {
        content.push_str(&format!("username:s:{}\n", profile.target.user));
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
