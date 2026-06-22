use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct AppearanceConfig {
    pub theme: String,
    pub accent: String,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub font_size: u16,
    pub font_family: String,
    pub font_ligatures: bool,
    pub nerd_font_fallback: bool,
    pub scrollback: u32,
    pub sidebar_width: u16,
    pub panel_width: u16,
    pub terminal_theme: String,
    pub external_editor: String,
    pub bell_notification: bool,
    pub terminal_clipboard_write: bool,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            accent: "#c2683c".into(),
            cursor_style: "bar".into(),
            cursor_blink: true,
            font_size: 14,
            font_family: "JetBrains Mono".into(),
            font_ligatures: false,
            nerd_font_fallback: true,
            scrollback: 2000,
            sidebar_width: 272,
            panel_width: 320,
            terminal_theme: "default".into(),
            external_editor: "vscode".into(),
            bell_notification: true,
            terminal_clipboard_write: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct ConduitConfig {
    pub appearance: AppearanceConfig,
    pub keybindings: BTreeMap<String, String>,
}

impl Default for ConduitConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceConfig::default(),
            keybindings: default_keybindings(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LoadedConduitConfig {
    pub path: String,
    pub config: ConduitConfig,
    pub error: Option<String>,
}

fn default_keybindings() -> BTreeMap<String, String> {
    [
        ("new_terminal", "Mod+T"),
        ("new_terminal_alt", "Mod+N"),
        ("close_session", "Mod+W"),
        ("open_settings", "Mod+,"),
        ("toggle_sidebar", "Mod+\\"),
        ("toggle_panel", "Mod+Shift+\\"),
        ("split_horizontal", "Mod+D"),
        ("split_vertical", "Mod+Shift+D"),
        ("focus_split_left", "Mod+["),
        ("focus_split_right", "Mod+]"),
        ("command_palette", "Mod+K"),
        ("quick_select", "Mod+Shift+Space"),
        ("font_size_up", "Mod+="),
        ("font_size_down", "Mod+-"),
        ("font_size_reset", "Mod+0"),
        ("select_tab_1", "Mod+1"),
        ("select_tab_2", "Mod+2"),
        ("select_tab_3", "Mod+3"),
        ("select_tab_4", "Mod+4"),
        ("select_tab_5", "Mod+5"),
        ("select_tab_6", "Mod+6"),
        ("select_tab_7", "Mod+7"),
        ("select_tab_8", "Mod+8"),
        ("select_last_tab", "Mod+9"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn config_path() -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join("conduit").join("config.toml"));
        }
    }
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("conduit")
        .join("config.toml"))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;
    }
    Ok(())
}

fn write_config(path: &Path, config: &ConduitConfig) -> Result<(), String> {
    ensure_parent(path)?;
    let body =
        toml::to_string_pretty(config).map_err(|e| format!("serialize config failed: {e}"))?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write config failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("replace config failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_config() -> Result<LoadedConduitConfig, String> {
    let path = config_path()?;
    let path_string = path.to_string_lossy().to_string();
    if !path.exists() {
        let config = ConduitConfig::default();
        write_config(&path, &config)?;
        return Ok(LoadedConduitConfig {
            path: path_string,
            config,
            error: None,
        });
    }

    let raw = fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
    match toml::from_str::<ConduitConfig>(&raw) {
        Ok(config) => Ok(LoadedConduitConfig {
            path: path_string,
            config,
            error: None,
        }),
        Err(e) => Ok(LoadedConduitConfig {
            path: path_string,
            config: ConduitConfig::default(),
            error: Some(format!("parse config failed: {e}")),
        }),
    }
}

#[tauri::command]
pub fn save_config(config: ConduitConfig) -> Result<(), String> {
    let path = config_path()?;
    write_config(&path, &config)
}
