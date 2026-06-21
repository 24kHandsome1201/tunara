import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
}

export interface SearchHit {
  path: string;
  rel: string;
  name: string;
  isDir: boolean;
}

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export function fsReadDir(path: string, includeHidden = false): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_read_dir", { path, includeHidden });
}

export function fsReadFile(path: string): Promise<ReadResult> {
  return invoke<ReadResult>("fs_read_file", { path });
}

export function fsSearch(
  root: string,
  query: string,
  limit = 80,
  includeHidden = false,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("fs_search", { root, query, limit, includeHidden });
}
