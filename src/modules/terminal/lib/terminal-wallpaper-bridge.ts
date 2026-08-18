import { invoke } from "@tauri-apps/api/core";
import type { ReadResult } from "@/modules/fs/fs-bridge";

export interface WallpaperImportResult {
  mime: string;
  width: number;
  height: number;
}

export type WallpaperImage = Extract<ReadResult, { kind: "image" }>;

export function importTerminalWallpaper(path: string): Promise<WallpaperImportResult> {
  return invoke<WallpaperImportResult>("terminal_wallpaper_import", { path });
}

export function loadTerminalWallpaper(): Promise<WallpaperImage | null> {
  return invoke<WallpaperImage | null>("terminal_wallpaper_load");
}

export function clearTerminalWallpaper(): Promise<void> {
  return invoke("terminal_wallpaper_clear");
}
