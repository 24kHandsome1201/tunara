import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, ReadResult, SearchHit } from "@/modules/fs/fs-bridge";

/**
 * 远程 SFTP 文件操作。返回类型与本地 fs-bridge 完全一致，
 * 这样 FileExplorer 可以按 session.kind 切换数据源而无需改 UI。
 *
 * `id` 是后端 PTY/SSH 会话的物理 id（session.ptyId）。
 * 只读浏览 + 下载——没有远程写/编辑。
 */
export function sshReadDir(id: number, path: string, includeHidden = false): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("ssh_fs_read_dir", { id, path, includeHidden });
}

export function sshReadFile(id: number, path: string): Promise<ReadResult> {
  return invoke<ReadResult>("ssh_fs_read_file", { id, path });
}

/** 解析远程 home 目录，作为文件面板初始路径。 */
export function sshHome(id: number): Promise<string> {
  return invoke<string>("ssh_fs_home", { id });
}

/** 下载远程文件到本地路径，返回写入字节数。 */
export function sshDownload(id: number, remotePath: string, localPath: string): Promise<number> {
  return invoke<number>("ssh_fs_download", { id, remotePath, localPath });
}

// ── Remote file search (over the SSH exec channel) ────────────────────────
// Mirrors the local fs_search contract so FileExplorer's search box works the
// same way for SSH sessions. A module-level cache absorbs repeated keystrokes
// for the same (session, root, query) triple so backspacing doesn't re-run
// `find` on the remote every debounce window.

/** Module-level result cache keyed by `${ptyId}|${root}|${query}`. Entries are
 *  small (≤80 hits) and evicted only by LRU cap — a remote search is the
 *  expensive kind (round-trips over SSH), so caching is high-value. */
const searchCache = new Map<string, SearchHit[]>();
const SEARCH_CACHE_MAX = 32;

function cacheKey(ptyId: number, root: string, query: string): string {
  return `${ptyId}|${root}|${query}`;
}

function evictIfNeeded(): void {
  if (searchCache.size <= SEARCH_CACHE_MAX) return;
  // Map preserves insertion order; drop the oldest entry.
  const oldest = searchCache.keys().next().value;
  if (oldest !== undefined) searchCache.delete(oldest);
}

export function sshSearch(
  ptyId: number,
  root: string,
  query: string,
  limit = 80,
): Promise<SearchHit[]> {
  const key = cacheKey(ptyId, root, query);
  const cached = searchCache.get(key);
  if (cached) {
    // Refresh LRU position by re-inserting at the end.
    searchCache.delete(key);
    searchCache.set(key, cached);
    return Promise.resolve(cached);
  }
  return invoke<SearchHit[]>("ssh_fs_search", { sessionId: ptyId, root, query, limit }).then((hits) => {
    evictIfNeeded();
    searchCache.set(key, hits);
    return hits;
  });
}

/** Invalidate the cache for one session (e.g. after a directory reload). */
export function invalidateRemoteSearchCache(ptyId: number): void {
  const prefix = `${ptyId}|`;
  for (const k of searchCache.keys()) {
    if (k.startsWith(prefix)) searchCache.delete(k);
  }
}
