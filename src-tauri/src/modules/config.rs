use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use toml_edit::{value, DocumentMut, Item, Table};

const MIN_FONT_SIZE: u16 = 10;
const MAX_FONT_SIZE: u16 = 22;
const DEFAULT_SCROLLBACK: u32 = 10_000;
const MIN_SIDEBAR_WIDTH: u16 = 200;
const MAX_SIDEBAR_WIDTH: u16 = 400;
const MIN_PANEL_WIDTH: u16 = 240;
const CONFIG_DIR: &str = "tunara";
const LEGACY_CONFIG_DIR: &str = "conduit";
static CONFIG_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    pub terminal_inline_images: bool,
    pub terminal_screen_reader_mode: bool,
    pub show_pure_mode_files_button: bool,
    pub terminal_host_modifier: String,
    pub language: String,
    pub global_shortcut: String,
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
            scrollback: 10_000,
            sidebar_width: 272,
            panel_width: 320,
            terminal_theme: "default".into(),
            external_editor: "vscode".into(),
            bell_notification: true,
            terminal_clipboard_write: false,
            terminal_inline_images: true,
            terminal_screen_reader_mode: false,
            show_pure_mode_files_button: true,
            terminal_host_modifier: if cfg!(target_os = "macos") {
                "meta"
            } else {
                "shift"
            }
            .into(),
            language: "system".into(),
            global_shortcut: "CmdOrCtrl+Shift+T".into(),
        }
    }
}

impl AppearanceConfig {
    fn clamp(&mut self) {
        if !matches!(
            self.terminal_host_modifier.as_str(),
            "shift" | "meta" | "alt"
        ) {
            self.terminal_host_modifier = if cfg!(target_os = "macos") {
                "meta"
            } else {
                "shift"
            }
            .into();
        }
        self.font_size = self.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        self.scrollback = DEFAULT_SCROLLBACK;
        self.sidebar_width = self
            .sidebar_width
            .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        // The upper bound is viewport-dependent in src/state/ui.ts; the backend must preserve
        // wider-screen values that the frontend already accepted.
        self.panel_width = self.panel_width.max(MIN_PANEL_WIDTH);
        if matches!(
            self.terminal_theme.as_str(),
            "catppuccin"
                | "tokyo-night"
                | "one-dark"
                | "solarized"
                | "github-light"
                | "rose-pine-dawn"
        ) {
            self.theme = "system".into();
            self.terminal_theme = "default".into();
        } else if self.terminal_theme != "default" {
            self.terminal_theme = "default".into();
        }
        self.accent = "#c2683c".into();
        self.terminal_inline_images = true;
    }
}

const TERMINAL_INTERACTIONS_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct TerminalInteractionsConfig {
    pub version: u16,
    pub secondary_click: String,
}

impl Default for TerminalInteractionsConfig {
    fn default() -> Self {
        Self {
            version: TERMINAL_INTERACTIONS_VERSION,
            secondary_click: "smart".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct TunaraConfig {
    pub appearance: AppearanceConfig,
    pub keybindings: BTreeMap<String, String>,
    pub terminal_interactions: TerminalInteractionsConfig,
}

impl Default for TunaraConfig {
    fn default() -> Self {
        Self {
            appearance: AppearanceConfig::default(),
            keybindings: default_keybindings(),
            terminal_interactions: TerminalInteractionsConfig::default(),
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
    default_keybindings_for(cfg!(target_os = "macos"))
}

fn default_keybindings_for(is_macos: bool) -> BTreeMap<String, String> {
    let mut bindings: BTreeMap<String, String> = old_default_keybindings();
    // Drop retired chords from the live default set. old_default_keybindings()
    // stays intact so complete historical tables still migrate in one shot.
    for key in [
        "new_terminal_alt",
        "cycle_next_session",
        "cycle_prev_session",
        "navigate_prev_block",
        "navigate_next_block",
    ] {
        bindings.remove(key);
    }
    bindings.insert("terminal_menu".into(), "".into());
    bindings.insert("focus_latest_attention".into(), "Mod+Enter".into());
    bindings.insert(
        "copy_selection".into(),
        if is_macos { "Mod+C" } else { "Ctrl+Shift+C" }.into(),
    );
    bindings.insert(
        "safe_paste".into(),
        if is_macos { "Mod+V" } else { "Ctrl+Shift+V" }.into(),
    );
    if !is_macos {
        bindings.insert("close_session".into(), "Ctrl+Shift+W".into());
        bindings.insert("split_horizontal".into(), "Alt+Shift+D".into());
        bindings.insert("command_palette".into(), "Ctrl+Shift+K".into());
    }
    bindings
}

fn old_default_keybindings() -> BTreeMap<String, String> {
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
        ("focus_split_up", "Mod+Shift+["),
        ("focus_split_down", "Mod+Shift+]"),
        ("command_palette", "Mod+K"),
        ("toggle_presentation_mode", "Mod+Shift+P"),
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
        ("cycle_next_session", "Mod+Tab"),
        ("cycle_prev_session", "Mod+Shift+Tab"),
        ("navigate_prev_block", "Mod+Shift+ArrowUp"),
        ("navigate_next_block", "Mod+Shift+ArrowDown"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn old_backend_default_keybindings() -> BTreeMap<String, String> {
    let mut bindings = old_default_keybindings();
    for key in [
        "focus_split_up",
        "focus_split_down",
        "cycle_next_session",
        "cycle_prev_session",
        "navigate_prev_block",
        "navigate_next_block",
    ] {
        bindings.remove(key);
    }
    bindings
}

fn raw_has_complete_old_keybindings(raw: &str) -> bool {
    let Ok(doc) = raw.parse::<DocumentMut>() else {
        return false;
    };
    let Some(table) = doc.get("keybindings").and_then(Item::as_table) else {
        return false;
    };
    [old_default_keybindings(), old_backend_default_keybindings()]
        .into_iter()
        .any(|old| {
            table.len() == old.len()
                && old.iter().all(|(key, expected)| {
                    table.get(key).and_then(Item::as_str) == Some(expected.as_str())
                })
        })
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

fn known_appearance_items(config: &AppearanceConfig) -> [(&'static str, Item); 21] {
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
        (
            "terminal_inline_images",
            value(config.terminal_inline_images),
        ),
        (
            "terminal_screen_reader_mode",
            value(config.terminal_screen_reader_mode),
        ),
        (
            "show_pure_mode_files_button",
            value(config.show_pure_mode_files_button),
        ),
        (
            "terminal_host_modifier",
            value(config.terminal_host_modifier.clone()),
        ),
        ("language", value(config.language.clone())),
        ("global_shortcut", value(config.global_shortcut.clone())),
    ]
}

fn ensure_document_table<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
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
        .parse::<DocumentMut>()
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

    // A newer Tunara may own fields and semantics this binary does not know.
    // Keep that table byte-for-byte instead of downgrading it on an unrelated
    // appearance/keybinding save.
    let future_terminal_interactions = doc
        .get("terminal_interactions")
        .and_then(Item::as_table)
        .and_then(|table| table.get("version"))
        .and_then(Item::as_integer)
        .is_some_and(|version| version > i64::from(TERMINAL_INTERACTIONS_VERSION));
    if !future_terminal_interactions {
        let terminal_interactions = ensure_document_table(&mut doc, "terminal_interactions")?;
        set_table_item(
            terminal_interactions,
            "version",
            value(i64::from(config.terminal_interactions.version)),
        );
        set_table_item(
            terminal_interactions,
            "secondary_click",
            value(config.terminal_interactions.secondary_click.clone()),
        );
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
    // Each process and write gets its own temporary path. This avoids two app
    // instances or overlapping IPC calls replacing each other's temp file.
    let sequence = CONFIG_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("toml.{}.{}.tmp", std::process::id(), sequence));
    fs::write(&tmp, body).map_err(|e| format!("write config failed: {e}"))?;
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace config failed: {error}"));
    }
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
            // Pre-version configs are migrated only when the raw table proves it is the
            // complete old built-in set. One changed/extra/missing value means user-owned.
            if raw_has_complete_old_keybindings(&raw) {
                config.keybindings = default_keybindings();
            }
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
    fn complete_old_defaults_migrate_but_a_custom_table_is_preserved() {
        let old = TunaraConfig {
            appearance: AppearanceConfig::default(),
            keybindings: old_default_keybindings(),
            terminal_interactions: TerminalInteractionsConfig::default(),
        };
        let old_raw = toml::to_string_pretty(&old).expect("serialize old defaults");
        assert!(raw_has_complete_old_keybindings(&old_raw));

        let path = temp_config_path("old-keybindings");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(&path, old_raw).expect("write old config");
        let loaded = load_config_from_path(&path).expect("load old config");
        assert_eq!(loaded.config.keybindings, default_keybindings());

        let old_backend = TunaraConfig {
            appearance: AppearanceConfig::default(),
            keybindings: old_backend_default_keybindings(),
            terminal_interactions: TerminalInteractionsConfig::default(),
        };
        let old_backend_raw =
            toml::to_string_pretty(&old_backend).expect("serialize old backend defaults");
        assert!(raw_has_complete_old_keybindings(&old_backend_raw));

        let mut custom = old;
        custom
            .keybindings
            .insert("close_session".into(), "Alt+Q".into());
        let custom_raw = toml::to_string_pretty(&custom).expect("serialize custom defaults");
        assert!(!raw_has_complete_old_keybindings(&custom_raw));
        fs::write(&path, custom_raw).expect("write custom config");
        let loaded = load_config_from_path(&path).expect("load custom config");
        assert_eq!(
            loaded
                .config
                .keybindings
                .get("close_session")
                .map(String::as_str),
            Some("Alt+Q")
        );
        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).expect("temp root"));
    }

    #[test]
    fn platform_defaults_keep_macos_conventions_and_avoid_bare_control_elsewhere() {
        let macos = default_keybindings_for(true);
        let linux_or_windows = default_keybindings_for(false);
        for (key, expected) in [
            ("copy_selection", "Mod+C"),
            ("safe_paste", "Mod+V"),
            ("close_session", "Mod+W"),
            ("split_horizontal", "Mod+D"),
            ("command_palette", "Mod+K"),
            ("focus_latest_attention", "Mod+Enter"),
        ] {
            assert_eq!(macos.get(key).map(String::as_str), Some(expected));
        }
        assert_eq!(macos.get("new_terminal_alt"), None);
        for (key, expected) in [
            ("copy_selection", "Ctrl+Shift+C"),
            ("safe_paste", "Ctrl+Shift+V"),
            ("close_session", "Ctrl+Shift+W"),
            ("split_horizontal", "Alt+Shift+D"),
            ("command_palette", "Ctrl+Shift+K"),
        ] {
            assert_eq!(
                linux_or_windows.get(key).map(String::as_str),
                Some(expected)
            );
        }
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
        config.appearance.accent = "#c2683c".into();
        config.appearance.scrollback = 99999999;
        config.appearance.font_size = 999;
        config.appearance.sidebar_width = 1;
        config.appearance.panel_width = 810;
        config.appearance.show_pure_mode_files_button = false;
        config
            .keybindings
            .insert("new_terminal".into(), "Mod+Shift+T".into());

        write_config(&path, &config).expect("merge existing config");
        let saved = fs::read_to_string(&path).expect("read saved config");
        assert!(saved.contains("# user-owned header"));
        assert!(saved.contains("# keep this with appearance"));
        assert!(saved.contains("future_flag = true"));
        assert!(saved.contains("future_action = \"Mod+F\""));
        assert!(saved.contains("scrollback = 10000"));
        assert!(saved.contains("font_size = 22"));
        assert!(saved.contains("sidebar_width = 200"));
        assert!(saved.contains("panel_width = 810"));

        let loaded = load_config_from_path(&path).expect("load merged config");
        assert_eq!(loaded.config.appearance.scrollback, DEFAULT_SCROLLBACK);
        assert_eq!(loaded.config.appearance.font_size, MAX_FONT_SIZE);
        assert_eq!(loaded.config.appearance.sidebar_width, MIN_SIDEBAR_WIDTH);
        assert_eq!(loaded.config.appearance.panel_width, 810);
        assert!(!loaded.config.appearance.show_pure_mode_files_button);

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
        assert!(saved.contains("scrollback = 10000"));
        assert!(saved.contains("panel_width = 810"));
        let loaded = load_config_from_path(&path).expect("load repaired config");
        assert_eq!(loaded.error, None);
        assert_eq!(loaded.config.appearance.scrollback, DEFAULT_SCROLLBACK);
        assert_eq!(loaded.config.appearance.panel_width, 810);

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn missing_config_file_writes_default_template() {
        let path = temp_config_path("missing");
        let loaded = load_config_from_path(&path).expect("write default config");
        assert_eq!(loaded.config.appearance.scrollback, DEFAULT_SCROLLBACK);
        let saved = fs::read_to_string(&path).expect("read default config");
        assert!(saved.contains("[appearance]"));
        assert!(saved.contains("[keybindings]"));
        assert!(saved.contains("scrollback = 10000"));
        assert!(saved.contains("show_pure_mode_files_button = true"));
        assert!(saved.contains("terminal_screen_reader_mode = false"));
        assert!(saved.contains("[terminal_interactions]"));
        assert!(saved.contains("secondary_click = \"smart\""));

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
        assert!(saved.contains("accent = \"#c2683c\""));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn terminal_interactions_merge_preserves_unknown_fields_and_future_versions() {
        let path = temp_config_path("terminal-interactions");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(
            &path,
            r##"[appearance]
theme = "dark"

[terminal_interactions]
version = 1
secondary_click = "disabled"
future_same_version = "keep"
"##,
        )
        .expect("write current terminal interactions");

        let mut config = TunaraConfig::default();
        config.terminal_interactions.secondary_click = "menu".into();
        write_config(&path, &config).expect("merge current terminal interactions");
        let saved = fs::read_to_string(&path).expect("read current merge");
        assert!(saved.contains("secondary_click = \"menu\""));
        assert!(saved.contains("future_same_version = \"keep\""));

        fs::write(
            &path,
            r##"[appearance]
theme = "dark"

[terminal_interactions]
version = 99
secondary_click = "future-gesture"
future_field = true
"##,
        )
        .expect("write future terminal interactions");
        config.appearance.theme = "light".into();
        write_config(&path, &config).expect("save around future table");
        let future_saved = fs::read_to_string(&path).expect("read future merge");
        assert!(future_saved.contains("version = 99"));
        assert!(future_saved.contains("secondary_click = \"future-gesture\""));
        assert!(future_saved.contains("future_field = true"));
        assert!(future_saved.contains("theme = \"light\""));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }

    #[test]
    fn removed_named_themes_fall_back_to_system_and_fixed_defaults() {
        let path = temp_config_path("legacy-theme");
        ensure_parent(&path).expect("create temp config dir");
        fs::write(
            &path,
            r##"[appearance]
theme = "dark"
terminal_theme = "catppuccin"
accent = "#4f6ef0"
scrollback = 2000
terminal_inline_images = false
"##,
        )
        .expect("write legacy theme config");

        let loaded = load_config_from_path(&path).expect("load legacy theme");
        assert_eq!(loaded.config.appearance.theme, "system");
        assert_eq!(loaded.config.appearance.terminal_theme, "default");
        assert_eq!(loaded.config.appearance.accent, "#c2683c");
        assert_eq!(loaded.config.appearance.scrollback, DEFAULT_SCROLLBACK);
        assert!(loaded.config.appearance.terminal_inline_images);

        write_config(&path, &loaded.config).expect("rewrite clamped config");
        let saved = fs::read_to_string(&path).expect("read rewritten config");
        assert!(saved.contains("theme = \"system\""));
        assert!(saved.contains("terminal_theme = \"default\""));
        assert!(saved.contains("accent = \"#c2683c\""));
        assert!(saved.contains("scrollback = 10000"));
        assert!(saved.contains("terminal_inline_images = true"));

        let _ = fs::remove_dir_all(path.parent().and_then(Path::parent).unwrap_or(&path));
    }
}
