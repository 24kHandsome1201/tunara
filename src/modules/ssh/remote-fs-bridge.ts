import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, GrepResponse, ReadResult, SearchHit, WriteTextResult } from "@/modules/fs/fs-bridge";
import { RemoteOperationCache, remoteOperationCacheKey } from "./remote-operation-cache.ts";
import {
  parseSshWriteOutcomeUnknown,
  requireSshWriteReconcileFields,
  type SshWriteOutcomeUnknown,
} from "./ssh-write-reconcile.ts";

/**
 * 远程 SFTP 文件操作。返回类型与本地 fs-bridge 完全一致，
 * 这样 FileExplorer 可以按 session.kind 切换数据源而无需改 UI。
 *
 * `id` 是后端 PTY/SSH 会话的物理 id（session.ptyId）。
 * 浏览、下载，以及带指纹冲突检测的安全文本保存。
 */
export function sshReadDir(id: number, path: string, includeHidden = false): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("ssh_fs_read_dir", { id, path, includeHidden });
}

export function sshReadFile(id: number, path: string): Promise<ReadResult> {
  return invoke<ReadResult>("ssh_fs_read_file", { id, path });
}

export function sshWriteTextFile(
  id: number,
  path: string,
  content: string,
  expectedFingerprint: string,
): Promise<WriteTextResult> {
  return invoke<WriteTextResult>("ssh_fs_write_text_file", {
    id,
    path,
    content,
    expectedFingerprint,
  });
}

export function sshReconcileTextWrite(
  id: number,
  path: string,
  attemptedFingerprint: string,
  expectedMode: number,
  replaceLockOwner: string,
): Promise<WriteTextResult> {
  requireSshWriteReconcileFields(attemptedFingerprint, expectedMode, replaceLockOwner);
  return invoke<WriteTextResult>("ssh_fs_reconcile_text_write", {
    id,
    path,
    attemptedFingerprint,
    expectedMode,
    replaceLockOwner,
  });
}

export interface SshWriteReconcileResult {
  outcome: SshWriteOutcomeUnknown;
  result: WriteTextResult;
}

/**
 * One-step UI helper for a rejected save. It accepts the raw Tauri error,
 * refuses non-canonical values before IPC, and preserves cleanupPending for
 * honest recovery messaging after the backend has reconciled bytes + mode.
 */
export async function sshReconcileOutcomeUnknownTextWrite(
  id: number,
  path: string,
  error: unknown,
): Promise<SshWriteReconcileResult> {
  const outcome = parseSshWriteOutcomeUnknown(error);
  if (!outcome) throw new Error("invalid SSH outcomeUnknown token");
  const result = await sshReconcileTextWrite(
    id,
    path,
    outcome.attemptedFingerprint,
    outcome.expectedMode,
    outcome.replaceLockOwner,
  );
  return { outcome, result };
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

/** Module-level result cache keyed by a JSON tuple of session/root/query/limit.
 *  Entries are small (≤80 hits) and evicted by an LRU cap — a remote search is the
 *  expensive kind (round-trips over SSH), so caching is high-value. */
const SEARCH_CACHE_MAX = 32;
const searchCache = new RemoteOperationCache<SearchHit[]>(SEARCH_CACHE_MAX);
let nextRemoteSearchRequest = 0;
const activeRemoteSearchRequests = new Map<number, string>();

function createRemoteSearchRequestId(ptyId: number): string {
  nextRemoteSearchRequest += 1;
  return `remote-${ptyId.toString(36)}-${Date.now().toString(36)}-${nextRemoteSearchRequest.toString(36)}`;
}

export function cancelRemoteSearch(ptyId: number): void {
  const requestId = activeRemoteSearchRequests.get(ptyId);
  activeRemoteSearchRequests.delete(ptyId);
  if (requestId) {
    void invoke<boolean>("fs_cancel_search", { requestId }).catch(() => {});
  }
}

function beginRemoteSearch(ptyId: number): string {
  cancelRemoteSearch(ptyId);
  const requestId = createRemoteSearchRequestId(ptyId);
  activeRemoteSearchRequests.set(ptyId, requestId);
  return requestId;
}

function finishRemoteSearch(ptyId: number, requestId: string): void {
  if (activeRemoteSearchRequests.get(ptyId) === requestId) {
    activeRemoteSearchRequests.delete(ptyId);
  }
}

export function sshSearch(
  ptyId: number,
  root: string,
  query: string,
  limit = 80,
): Promise<SearchHit[]> {
  cancelRemoteSearch(ptyId);
  const key = remoteOperationCacheKey("find", ptyId, root, query, limit);
  const cached = searchCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const generation = searchCache.sessionGeneration(ptyId);
  const requestId = beginRemoteSearch(ptyId);
  return invoke<SearchHit[]>("ssh_fs_search", {
    request: { sessionId: ptyId, root, query, limit, requestId },
  })
    .then((hits) => {
      searchCache.setIfCurrent(key, ptyId, generation, hits);
      return hits;
    })
    .finally(() => finishRemoteSearch(ptyId, requestId));
}

// ── Remote content search (over the SSH exec channel) ─────────────────────
// Mirrors the local fs_grep contract (same GrepResponse shape) so
// FileExplorer's content-search mode works for SSH sessions. Cached like the
// name search: grep is the most expensive remote round-trip we make from the
// panel, and backspacing through a query must not re-run it every debounce.

const GREP_CACHE_MAX = 16;
const grepCache = new RemoteOperationCache<GrepResponse>(GREP_CACHE_MAX);

export function sshGrep(
  ptyId: number,
  root: string,
  pattern: string,
  maxResults = 200,
): Promise<GrepResponse> {
  cancelRemoteSearch(ptyId);
  const key = remoteOperationCacheKey("grep", ptyId, root, pattern, maxResults);
  const cached = grepCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const generation = grepCache.sessionGeneration(ptyId);
  const requestId = beginRemoteSearch(ptyId);
  return invoke<GrepResponse>("ssh_fs_grep", {
    request: {
      sessionId: ptyId,
      root,
      pattern,
      maxResults,
      requestId,
    },
  }).then((resp) => {
    grepCache.setIfCurrent(key, ptyId, generation, resp);
    return resp;
  }).finally(() => finishRemoteSearch(ptyId, requestId));
}

/** Invalidate the caches for one session (e.g. after a directory reload). */
export function invalidateRemoteSearchCache(ptyId: number): void {
  cancelRemoteSearch(ptyId);
  searchCache.invalidateSession(ptyId);
  grepCache.invalidateSession(ptyId);
}
