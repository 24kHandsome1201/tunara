mod modules;

use modules::agent::hooks::HookListenerState;
use modules::resolver::ResolverState;
use modules::{fs, pty};
use tauri::{AppHandle, Manager};

fn show_main_window(app: &AppHandle, reason: &str) {
    #[cfg(target_os = "macos")]
    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
        log::warn!("activation policy reset failed during {reason}: {e}");
    }
    if let Some(window) = app.get_webview_window("main") {
        let visible_before = window.is_visible().ok();
        let minimized_before = window.is_minimized().ok();
        if let Err(e) = window.unminimize() {
            log::warn!("main window unminimize failed during {reason}: {e}");
        }
        if let Err(e) = window.show() {
            log::warn!("main window show failed during {reason}: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("main window focus failed during {reason}: {e}");
        }
        log::info!(
            "main window restored during {reason}: visible_before={visible_before:?} minimized_before={minimized_before:?} visible_after={:?} minimized_after={:?}",
            window.is_visible().ok(),
            window.is_minimized().ok()
        );
    } else {
        log::warn!("main window unavailable during {reason}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Must be first: a second process must exit before it can start hook
        // listeners, restore PTYs, or open the shared workspace store.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app, "single-instance");
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        // window.confirm/alert are silent no-ops inside wry's WKWebView (no JS
        // dialog UI delegate) — native confirms must go through this plugin.
        .plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "m2-safe-write-benchmark")]
    let builder = builder.plugin(modules::ssh::m2_safe_write_benchmark::init());
    builder
        .manage(pty::PtyState::default())
        .manage(fs::grep::FsSearchCancellationState::default())
        .manage(ResolverState::default())
        .manage(modules::preview::PreviewWindowState::default())
        .manage(modules::git::GitWatcherState::default())
        .setup(|app| {
            // 修 P0-4：启动时尽早探测 login shell PATH，供 resolve_all_bins 用（§3.7.2）。
            let resolver = app.state::<ResolverState>();
            resolver.init_login_path();

            let hook_listener = modules::agent::hooks::start_listener(app.handle().clone());
            app.manage(hook_listener);
            // Event Store is deliberately initialized after the PTY/hook runtime and
            // always manages a fail-safe state. Corrupt/disabled data must never make
            // Tauri setup or ordinary terminals fail.
            app.manage(modules::agent_event_store::AgentEventStoreState::from_app(
                app.handle(),
            ));
            show_main_window(app.handle(), "setup");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_output_ack,
            pty::pty_resize,
            pty::pty_close,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_text_file,
            fs::search::fs_search,
            fs::grep::fs_grep,
            fs::grep::fs_cancel_search,
            // Tunara 新增（§3.7.2 CLI 路径解析）
            modules::resolver::resolve_all_bins,
            modules::resolver::set_bin_override,
            modules::resolver::clear_bin_overrides,
            // Tunara 新增（agent CLI 检测）
            modules::agent::preflight::agent_preflight,
            modules::agent::preflight::agent_preflight_invalidate,
            modules::agent_event_store::agent_event_store_status,
            modules::agent_event_store::agent_event_store_set_enabled,
            modules::agent_event_store::agent_event_append,
            modules::agent_event_store::agent_event_list,
            modules::agent_event_store::agent_event_payload,
            modules::agent_event_store::agent_event_delete,
            // Tunara 新增（§3.4 git 集成）
            modules::git::git_status,
            modules::git::git_diff,
            modules::git::git_ahead_behind,
            modules::git::workspace::git_workspace_context,
            modules::git::watcher::git_watch,
            modules::git::watcher::git_unwatch,
            // Tunara 新增（§6.3 外部编辑器跳转）
            modules::editor::open_in_editor,
            // Text config: ~/.config/tunara/config.toml
            modules::config::load_config,
            modules::config::save_config,
            modules::workspace_store::workspace_store_file_state,
            modules::preview::preview_open,
            modules::preview::preview_refresh,
            modules::preview::preview_status,
            modules::preview::preview_navigate,
            modules::preview::preview_go_back,
            modules::preview::preview_go_forward,
            modules::preview::preview_set_zoom,
            modules::preview::preview_reset_zoom,
            modules::preview::preview_set_viewport,
            modules::preview::preview_reset_viewport,
            modules::preview::preview_fit_viewport,
            modules::preview::preview_telemetry_ingest,
            modules::preview::preview_telemetry_clear,
            modules::preview::preview_telemetry_send,
            modules::preview::preview_terminal_command_started,
            modules::preview::preview_terminal_command_finished,
            modules::preview::preview_terminal_exited,
            modules::preview::preview_remote_source_observed,
            modules::preview::preview_tunnel_open,
            modules::preview::preview_tunnel_status,
            modules::preview::preview_tunnel_close,
            modules::preview::preview_restart_prepare,
            modules::preview::preview_capture,
            modules::preview::preview_send_capture_to_source_terminal,
            modules::preview::preview_close,
            // §ssh-client SSH 会话(复用 pty_write/resize/close 驱动)
            modules::ssh::ssh_open,
            modules::ssh::ssh_cancel_open,
            // §ssh-client 未知主机密钥 TOFU 指纹确认回传
            modules::ssh::ssh_host_key_decision,
            // §ssh-client Phase 2 主机 profile 管理(无凭证存储)
            modules::ssh::hosts::ssh_hosts_load,
            modules::ssh::hosts::ssh_hosts_save,
            modules::ssh::hosts::ssh_hosts_remove,
            modules::ssh::hosts::ssh_hosts_import_config,
            // §ssh-client Phase 3 SFTP 远程文件(只读浏览 + 下载)
            modules::ssh::sftp::ssh_fs_read_dir,
            modules::ssh::sftp::ssh_fs_read_file,
            modules::ssh::sftp::ssh_fs_write_text_file,
            modules::ssh::sftp::ssh_fs_reconcile_text_write,
            modules::ssh::sftp::ssh_fs_download,
            modules::ssh::sftp::ssh_fs_home,
            // Remote git status/diff over the SSH exec channel (review rail for
            // SSH sessions — complements the read-only local git2 path).
            modules::ssh::remote_git::ssh_git_status,
            modules::ssh::remote_git::ssh_git_diff,
            modules::ssh::remote_git::ssh_git_ahead_behind,
            modules::ssh::remote_git::ssh_git_workspace_context,
            modules::ssh::remote_git::ssh_fs_search,
            modules::ssh::remote_git::ssh_fs_grep,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                show_main_window(app, "ready");
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                show_main_window(app, "reopen");
            }
            tauri::RunEvent::Exit => {
                app.state::<modules::preview::PreviewWindowState>()
                    .close_all_tunnels(app);
                app.state::<pty::PtyState>().close_all();
                app.state::<HookListenerState>().shutdown();
            }
            _ => {}
        });
}
