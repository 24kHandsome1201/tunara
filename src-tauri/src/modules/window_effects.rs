#[tauri::command]
pub fn set_window_background_blur(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::utils::config::WindowEffectsConfig;
        use tauri::window::{Effect, EffectState};
        let effects = enabled.then(|| WindowEffectsConfig {
            effects: vec![Effect::UnderWindowBackground],
            state: Some(EffectState::FollowsWindowActiveState),
            radius: None,
            color: None,
        });
        window.set_effects(effects).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, enabled);
    Ok(())
}
