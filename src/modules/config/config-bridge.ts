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
  language: string;
  global_shortcut: string;
}

export interface RawTunaraConfig {
  appearance: RawAppearanceConfig;
  keybindings: Record<string, string>;
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
