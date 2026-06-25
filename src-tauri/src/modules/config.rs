use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{value, Document, Item, Table};

const MIN_FONT_SIZE: u16 = 10;
const MAX_FONT_SIZE: u16 = 22;
const MIN_SCROLLBACK: u32 = 1000;
const MAX_SCROLLBACK: u32 = 20_000;
const MIN_SIDEBAR_WIDTH: u16 = 200;
const MAX_SIDEBAR_WIDTH: u16 = 400;
const MIN_PANEL_WIDTH: u16 = 240;
const CONFIG_DIR: &str = "tunara";
const LEGACY_CONFIG_DIR: &str = "conduit";

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
    pub language: String,
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
            language: "system".into(),
        }
    }
}

impl AppearanceConfig {
    fn clamp(&mut self) {
        self.font_size = self.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        self.scrollback = self.scrollback.clamp(MIN_SCROLLBACK, MAX_SCROLLBACK);
        self.sidebar_width = self
            .sidebar_width
            .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        // The upper bound is viewport-dependent in src/state/ui.ts; the backend must preserve
        // wider-screen values that the frontend already accepted.
        self.panel_width = self.panel_width.max(MIN_PANEL_WIDTH);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct TunaraConfig {
    pub appearance: AppearanceConfig,
    pub keybindings: BTreeMap<String, String>,
}

impl Default for TunaraConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceConfig::default(),
            keybindings: default_keybindings(),
        }
    }
}

impl TunaraConfig {
    fn clamp(&mut self) {
        self.appearance.clamp();
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct LoadedTunaraConfig {
    pub path: String,
    pub config: TunaraConfig,
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

fn config_path_for_dir(dir_name: &str) -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join(dir_name).join("config.toml"));
        }
    }
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join(dir_name)
        .join("config.toml"))
}

fn config_path() -> Result<PathBuf, String> {
    config_path_for_dir(CONFIG_DIR)
}

fn legacy_config_path() -> Result<PathBuf, String> {
    config_path_for_dir(LEGACY_CONFIG_DIR)
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;
    }
    Ok(())
}

fn known_appearance_items(config: &AppearanceConfig) -> [(&'static str, Item); 16] {
    [
        ("theme", value(config.theme.clone())),
        ("accent", value(config.accent.clone())),
        ("cursor_style", value(config.cursor_style.clone())),
        ("cursor_blink", value(config.cursor_blink)),
        ("font_size", value(i64::from(config.font_size))),
        ("font_family", value(config.font_family.clone())),
        ("font_ligatures", value(config.font_ligatures)),
        ("nerd_font_fallback", value(config.nerd_font_fallback)),
        ("scrollback", value(i64::from(config.scrollback))),
        ("sidebar_width", value(i64::from(config.sidebar_width))),
        ("panel_width", value(i64::from(config.panel_width))),
        ("terminal_theme", value(config.terminal_theme.clone())),
        ("external_editor", value(config.external_editor.clone())),
        ("bell_notification", value(config.bell_notification)),
        (
            "terminal_clipboard_write",
            value(config.terminal_clipboard_write),
        ),
        ("language", value(config.language.clone())),
    ]
}

fn ensure_document_table<'a>(doc: &'a mut Document, key: &str) -> Result<&'a mut Table, String> {
    let item = doc
        .as_table_mut()
        .entry(key)
        .or_insert(Item::Table(Table::new()));
    if !item.is_table() {
        *item = Item::Table(Table::new());
    }
    item.as_table_mut()
        .ok_or_else(|| format!("config section `{key}` is not a table"))
}

fn set_table_item(table: &mut Table, key: &str, item: Item) {
    if let Some(existing) = table.get_mut(key) {
        *existing = item;
    } else {
        table.insert(key, item);
    }
}

fn merge_known_config(raw: &str, config: &TunaraConfig) -> Result<String, String> {
    let mut doc = raw
        .parse::<Document>()
        .map_err(|e| format!("parse existing config failed: {e}"))?;

    {
        let appearance = ensure_document_table(&mut doc, "appearance")?;
        for (key, item) in known_appearance_items(&config.appearance) {
            set_table_item(appearance, key, item);
        }
    }

    {
        let keybindings = ensure_document_table(&mut doc, "keybindings")?;
        for (key, binding) in &config.keybindings {
            set_table_item(keybindings, key, value(binding.clone()));
        }
    }

    Ok(doc.to_string())
}

fn serialize_new_config(config: &TunaraConfig) -> Result<String, String> {
    toml::to_string_pretty(config).map_err(|e| format!("serialize config failed: {e}"))
}

fn write_config(path: &Path, config: &TunaraConfig) -> Result<(), String> {
    ensure_parent(path)?;
    let mut config = config.clone();
    config.clamp();
    let body = if path.exists() {
        let raw = fs::read_to_string(path).map_err(|e| format!("read config failed: {e}"))?;
        match merge_known_config(&raw, &config) {
            Ok(body) => body,
            Err(_) => serialize_new_config(&config)?,
        }
    } else {
        serialize_new_config(&config)?
    };
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write config failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("replace config failed: {e}"))?;
    Ok(())
}

fn load_config_from_path(path: &Path) -> Result<LoadedTunaraConfig, String> {
    let path_string = path.to_string_lossy().to_string();
    if !path.exists() {
        let mut config = TunaraConfig::default();
        config.clamp();
        write_config(path, &config)?;
        return Ok(LoadedTunaraConfig {
            path: path_string,
            config,
            error: None,
        });
    }

    let raw = fs::read_to_string(path).map_err(|e| format!("read config failed: {e}"))?;
    match toml::from_str::<TunaraConfig>(&raw) {
        Ok(mut config) => {
            config.clamp();
            Ok(LoadedTunaraConfig {
                path: path_string,
                config,
                error: None,
            })
        }
        Err(e) => {
            let mut config = TunaraConfig::default();
            config.clamp();
            Ok(LoadedTunaraConfig {
                path: path_string,
                config,
                error: Some(format!("parse config failed: {e}")),
            })
        }
    }
}

fn migrate_legacy_config_if_needed(path: &Path, legacy_path: &Path) -> Result<(), String> {
    if path.exists() || !legacy_path.exists() {
        return Ok(());
    }
    ensure_parent(path)?;
    fs::copy(legacy_path, path).map_err(|e| format!("migrate legacy config failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_config() -> Result<LoadedTunaraConfig, String> {
    let path = config_path()?;
    let legacy_path = legacy_config_path()?;
    migrate_legacy_config_if_needed(&path, &legacy_path)?;
    load_config_from_path(&path)
}

#[tauri::command]
pub fn save_config(config: TunaraConfig) -> Result<(), String> {
    let path = config_path()?;
    write_config(&path, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("tunara-config-test-{name}-{unique}"))
            .join("tunara")
            .join("config.toml")
    }

    fn temp_named_config_path(name: &str, dir_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("tunara-config-test-{name}-{unique}"))
            .join(dir_name)
            .join("config.toml")
    }

    #[test]
    fn config_write_preserves_comments_unknown_keys_and_clamps_loaded_values() {
        let path = temp_config_path("preserve");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(
            &path,
            r##"# user-owned header
[appearance]
# keep this with appearance
future_flag = true
font_size = 999
scrollback = 99999999
sidebar_width = 1
panel_width = 1
accent = "#123456"

[keybindings]
future_action = "Mod+F"
"##,
        )
        .expect("write existing config");

        let loaded_before_save = load_config_from_path(&path).expect("load existing config");
        assert_eq!(
            loaded_before_save.config.appearance.panel_width,
            MIN_PANEL_WIDTH
        );

        let mut config = TunaraConfig::default();
        config.appearance.accent = "#abcdef".into();
        config.appearance.scrollback = 99999999;
        config.appearance.font_size = 999;
        config.appearance.sidebar_width = 1;
        config.appearance.panel_width = 810;
        config
            .keybindings
            .insert("new_terminal".into(), "Mod+Shift+T".into());

        write_config(&path, &config).expect("merge existing config");
        let saved = fs::read_to_string(&path).expect("read saved config");
        assert!(saved.contains("# user-owned header"));
        assert!(saved.contains("# keep this with appearance"));
        assert!(saved.contains("future_flag = true"));
        assert!(saved.contains("future_action = \"Mod+F\""));
        assert!(saved.contains("scrollback = 20000"));
        assert!(saved.contains("font_size = 22"));
        assert!(saved.contains("sidebar_width = 200"));
        assert!(saved.contains("panel_width = 810"));

        let loaded = load_config_from_path(&path).expect("load merged config");
        assert_eq!(loaded.config.appearance.scrollback, MAX_SCROLLBACK);
        assert_eq!(loaded.config.appearance.font_size, MAX_FONT_SIZE);
        assert_eq!(loaded.config.appearance.sidebar_width, MIN_SIDEBAR_WIDTH);
        assert_eq!(loaded.config.appearance.panel_width, 810);

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn legacy_config_is_copied_to_tunara_path_once() {
        let legacy_path = temp_named_config_path("legacy", LEGACY_CONFIG_DIR);
        let path = legacy_path
            .parent()
            .and_then(Path::parent)
            .expect("test config root")
            .join(CONFIG_DIR)
            .join("config.toml");
        ensure_parent(&legacy_path).expect("create legacy config dir");
        fs::write(
            &legacy_path,
            r##"# migrated user config
[appearance]
future_flag = true
font_size = 15
"##,
        )
        .expect("write legacy config");

        migrate_legacy_config_if_needed(&path, &legacy_path).expect("migrate legacy config");

        let migrated = fs::read_to_string(&path).expect("read migrated config");
        assert!(migrated.contains("# migrated user config"));
        assert!(migrated.contains("future_flag = true"));
        let loaded = load_config_from_path(&path).expect("load migrated config");
        assert_eq!(loaded.config.appearance.font_size, 15);

        fs::write(&legacy_path, "font_size = 20").expect("rewrite legacy config");
        migrate_legacy_config_if_needed(&path, &legacy_path).expect("skip second migration");
        let migrated_again = fs::read_to_string(&path).expect("read migrated config again");
        assert!(migrated_again.contains("# migrated user config"));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn malformed_existing_config_can_be_replaced_by_saving() {
        let path = temp_config_path("malformed");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(&path, "[appearance\nscrollback = 99999999\n").expect("write malformed config");

        let mut config = TunaraConfig::default();
        config.appearance.scrollback = 99999999;
        config.appearance.panel_width = 810;

        write_config(&path, &config).expect("replace malformed config");
        let saved = fs::read_to_string(&path).expect("read saved config");
        assert!(saved.contains("[appearance]"));
        assert!(saved.contains("scrollback = 20000"));
        assert!(saved.contains("panel_width = 810"));
        let loaded = load_config_from_path(&path).expect("load repaired config");
        assert_eq!(loaded.error, None);
        assert_eq!(loaded.config.appearance.scrollback, MAX_SCROLLBACK);
        assert_eq!(loaded.config.appearance.panel_width, 810);

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn missing_config_file_writes_default_template() {
        let path = temp_config_path("missing");
        let loaded = load_config_from_path(&path).expect("write default config");
        assert_eq!(loaded.config.appearance.scrollback, 2000);
        let saved = fs::read_to_string(&path).expect("read default config");
        assert!(saved.contains("[appearance]"));
        assert!(saved.contains("[keybindings]"));
        assert!(saved.contains("scrollback = 2000"));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn existing_config_without_language_field_loads_default_and_merges_on_save() {
        let path = temp_config_path("no-language");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(
            &path,
            r##"[appearance]
theme = "dark"
accent = "#abcdef"
"##,
        )
        .expect("write pre-i18n config");

        let loaded = load_config_from_path(&path).expect("load pre-i18n config");
        assert_eq!(loaded.config.appearance.language, "system");
        assert_eq!(loaded.config.appearance.theme, "dark");
        assert_eq!(loaded.error, None);

        let mut config = loaded.config.clone();
        config.appearance.language = "en".into();
        write_config(&path, &config).expect("save with language");
        let saved = fs::read_to_string(&path).expect("read saved config");
        assert!(saved.contains("language = \"en\""));
        assert!(saved.contains("accent = \"#abcdef\""));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }
}
