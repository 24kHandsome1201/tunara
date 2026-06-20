import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
}

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export function fsReadDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_read_dir", { path });
}

export function fsReadFile(path: string): Promise<ReadResult> {
  return invoke<ReadResult>("fs_read_file", { path });
}
