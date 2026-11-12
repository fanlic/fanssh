mod ai;
mod app;
mod crypto;
mod ipc;
mod profile;
mod serial;
mod session;
mod transport;
mod util;
mod vault;

use ipc::commands::*;
use tauri::Manager;

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app::resolve_data_dir(app.handle())?;
            log::info!("[fanssh] 数据目录: {}", data_dir.display());
            let state = app::AppState::init(data_dir)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            term_open,
            term_input,
            term_resize,
            term_close,
            serial_list_ports,
            serial_open,
            serial_input,
            serial_set_lines,
            serial_close,
            profile_list,
            profile_upsert,
            profile_delete,
            profile_export,
            profile_import,
            vault_put,
            vault_list,
            vault_delete,
            sftp_open,
            sftp_list,
            sftp_chmod,
            sftp_upload,
            sftp_download,
            sftp_close,
            ai_settings_get,
            ai_settings_save,
            ai_chat,
            ai_nl2cmd,
            rdp_launch,
            updater_status,
            updater_check,
            updater_install,
        ])
        .run(tauri::generate_context!())
        .expect("FanSSH 启动失败");
}
