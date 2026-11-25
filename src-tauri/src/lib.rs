mod ai;
mod app;
mod crypto;
mod docker;
mod ipc;
mod known_hosts;
mod monitor;
mod profile;
mod serial;
mod session;
mod transport;
mod tunnel;
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
            local_term_open,
            term_input,
            term_resize,
            term_close,
            term_auth_respond,
            term_host_key_respond,
            ssh_test_connection,
            read_text_file,
            docker_containers,
            docker_logs,
            monitor_start,
            monitor_stop,
            serial_list_ports,
            serial_open,
            serial_input,
            serial_set_lines,
            serial_close,
            telnet_open,
            telnet_input,
            telnet_close,
            vnc_open,
            vnc_input,
            vnc_close,
            rdp_open,
            rdp_input,
            rdp_close,
            profile_list,
            profile_upsert,
            profile_delete,
            profile_export,
            profile_import,
            vault_put,
            vault_list,
            vault_delete,
            known_hosts_list,
            known_hosts_delete,
            sftp_open,
            sftp_list,
            sftp_chmod,
            sftp_upload,
            sftp_download,
            sftp_rename,
            sftp_mkdir,
            sftp_remove,
            sftp_read_text,
            sftp_write_text,
            sftp_local_exists,
            sftp_close,
            ai_settings_get,
            ai_settings_save,
            ui_settings_get,
            ui_settings_save,
            ai_chat,
            ai_nl2cmd,
            tunnel_start,
            tunnel_stop,
            tunnel_active,
            updater_status,
            app_platform,
            updater_check,
            updater_install,
            open_external,
        ])
        .build(tauri::generate_context!())
        .expect("FanSSH 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<app::AppState>().local.close_all();
            }
        });
}
