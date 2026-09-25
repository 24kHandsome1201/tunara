#[tauri::command]
pub fn set_window_background_blur(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                // Tauri's `set_effects(None)` is a no-op on macOS, so the
                // effect view is removed explicitly before any re-apply.
                let _ = window_vibrancy::clear_vibrancy(&target);
                if enabled {
                    let _ = window_vibrancy::apply_vibrancy(
                        &target,
                        NSVisualEffectMaterial::UnderWindowBackground,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    );
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, enabled);
    Ok(())
}
