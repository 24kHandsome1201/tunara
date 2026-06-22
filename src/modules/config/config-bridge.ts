import { invoke } from "@tauri-apps/api/core";

export interface RawAppearanceConfig {
  theme: string;
  accent: string;
  cursor_style: string;
  cursor_blink: boolean;
  font_size: number;
  font_family: string;
  nerd_font_fallback: boolean;
  scrollback: number;
  sidebar_width: number;
  panel_width: number;
  terminal_theme: string;
  external_editor: string;
  bell_notification: boolean;
}

export interface RawConduitConfig {
  appearance: RawAppearanceConfig;
  keybindings: Record<string, string>;
}

export interface LoadedConduitConfig {
  path: string;
  config: RawConduitConfig;
  error?: string | null;
}

export function loadConduitConfig(): Promise<LoadedConduitConfig> {
  return invoke<LoadedConduitConfig>("load_config");
}

export function saveConduitConfig(config: RawConduitConfig): Promise<void> {
  return invoke("save_config", { config });
}
