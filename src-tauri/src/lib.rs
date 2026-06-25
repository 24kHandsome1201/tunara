mod modules;

use modules::agent::hooks::HookListenerState;
use modules::resolver::ResolverState;
use modules::{fs, pty};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(ResolverState::default())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<pty::PtyState>().close_all();
                window.state::<HookListenerState>().shutdown();
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            // 修 P0-4：启动时尽早探测 login shell PATH，供 resolve_bin 用（§3.7.2）。
            let resolver = app.state::<ResolverState>();
            resolver.init_login_path();

            let hook_listener = modules::agent::hooks::start_listener(app.handle().clone());
            app.manage(hook_listener);

            // M6：macOS 毛玻璃（§3.6）
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_stat,
            fs::search::fs_search,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            // Tunara 新增（§3.7.2 CLI 路径解析）
            modules::resolver::resolve_bin,
            modules::resolver::resolve_all_bins,
            modules::resolver::set_bin_override,
            // Tunara 新增（agent CLI 检测）
            modules::agent::preflight::agent_preflight,
            // Tunara 新增（§3.4 git 集成）
            modules::git::git_status,
            modules::git::git_diff,
            modules::git::git_ahead_behind,
            // Tunara 新增（§6.3 外部编辑器跳转）
            modules::editor::open_in_editor,
            // Text config: ~/.config/tunara/config.toml
            modules::config::load_config,
            modules::config::save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
