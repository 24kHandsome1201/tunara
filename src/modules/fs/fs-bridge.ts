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
  | { kind: "text"; content: string; size: number; truncated?: boolean }
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

// ── Content search (fs_grep) ───────────────────────────────────────────────
// Wraps the registered `fs_grep` command (src-tauri/src/modules/fs/grep.rs).
// Returns per-line matches across files under `root`, respecting .gitignore
// and hidden-file rules on the backend. Read-only. Remote sessions have no
// ssh_fs_grep yet — keep this local-only.

export interface GrepHit {
  path: string;
  rel: string;
  line: number;
  text: string;
}

export interface GrepResponse {
  hits: GrepHit[];
  truncated: boolean;
  filesScanned: number;
}

export function fsGrep(
  pattern: string,
  root: string,
  opts?: { glob?: string[]; caseInsensitive?: boolean; maxResults?: number },
): Promise<GrepResponse> {
  return invoke<GrepResponse>("fs_grep", {
    pattern,
    root,
    glob: opts?.glob,
    caseInsensitive: opts?.caseInsensitive,
    maxResults: opts?.maxResults,
  });
}
