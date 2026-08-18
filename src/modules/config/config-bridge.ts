import { invoke } from "@tauri-apps/api/core";

export interface RawAppearanceConfig {
  theme: string;
  accent: string;
  cursor_style: string;
  cursor_blink: boolean;
  font_size: number;
  font_family: string;
  font_ligatures: boolean;
  nerd_font_fallback: boolean;
  scrollback: number;
  sidebar_width: number;
  panel_width: number;
  terminal_theme: string;
  external_editor: string;
  bell_notification: boolean;
  terminal_clipboard_write: boolean;
  terminal_inline_images: boolean;
  terminal_screen_reader_mode: boolean;
  show_pure_mode_files_button: boolean;
  terminal_host_modifier: "shift" | "meta" | "alt";
  language: string;
  global_shortcut: string;
  terminal_wallpaper?: boolean;
  terminal_wallpaper_source?: string;
  terminal_wallpaper_blur?: number;
  terminal_wallpaper_veil?: number;
}

export interface RawTerminalInteractionsConfig {
  version?: number;
  secondary_click?: string;
}

export interface RawLocalUsageLoggingConfig {
  version?: number;
  enabled?: boolean;
}

export interface RawTunaraConfig {
  appearance: RawAppearanceConfig;
  keybindings: Record<string, string>;
  terminal_interactions?: RawTerminalInteractionsConfig;
  local_usage_logging?: RawLocalUsageLoggingConfig;
}

export interface LoadedTunaraConfig {
  path: string;
  config: RawTunaraConfig;
  error?: string | null;
}

export function loadTunaraConfig(): Promise<LoadedTunaraConfig> {
  return invoke<LoadedTunaraConfig>("load_config");
}

export function saveTunaraConfig(config: RawTunaraConfig): Promise<void> {
  return invoke("save_config", { config });
}
