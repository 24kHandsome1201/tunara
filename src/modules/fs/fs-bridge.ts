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

let nextLocalNameSearchRequest = 0;
let activeLocalNameSearchRequestId: string | null = null;

function createLocalNameSearchRequestId(): string {
  nextLocalNameSearchRequest += 1;
  return `name-${Date.now().toString(36)}-${nextLocalNameSearchRequest.toString(36)}`;
}

function cancelSearchRequest(requestId: string): Promise<boolean> {
  return invoke<boolean>("fs_cancel_search", { requestId });
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
  if (activeLocalNameSearchRequestId) {
    void cancelSearchRequest(activeLocalNameSearchRequestId).catch(() => {});
  }
  const requestId = createLocalNameSearchRequestId();
  activeLocalNameSearchRequestId = requestId;
  return invoke<SearchHit[]>("fs_search", { root, query, limit, includeHidden, requestId })
    .finally(() => {
      if (activeLocalNameSearchRequestId === requestId) {
        activeLocalNameSearchRequestId = null;
      }
    });
}

export function fsCancelActiveNameSearch(): void {
  const requestId = activeLocalNameSearchRequestId;
  activeLocalNameSearchRequestId = null;
  if (requestId) {
    void cancelSearchRequest(requestId).catch(() => {});
  }
}

// ── Content search (fs_grep) ───────────────────────────────────────────────
// Wraps the registered `fs_grep` command (src-tauri/src/modules/fs/grep.rs).
// Returns per-line matches across files under `root`, respecting .gitignore
// and hidden-file rules on the backend. Read-only. The remote counterpart is
// sshGrep (ssh_fs_grep) in @/modules/ssh/remote-fs-bridge, sharing this
// GrepResponse shape.

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
  opts: { requestId: string; glob?: string[]; caseInsensitive?: boolean; maxResults?: number },
): Promise<GrepResponse> {
  return invoke<GrepResponse>("fs_grep", {
    pattern,
    root,
    glob: opts.glob,
    caseInsensitive: opts.caseInsensitive,
    maxResults: opts.maxResults,
    requestId: opts.requestId,
  });
}

export function fsCancelGrep(requestId: string): Promise<boolean> {
  return cancelSearchRequest(requestId);
}
