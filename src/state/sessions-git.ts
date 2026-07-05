import { getNumberRecordValue } from "@/state/record-keys";

export const GIT_REFRESH_THROTTLE_MS = 1500;

type GitNonceStoreSlice = { gitNonce: Record<string, number> };
type GitNonceSetter = (fn: (state: GitNonceStoreSlice) => Partial<GitNonceStoreSlice>) => void;

const lastGitRefreshAt = new Map<string, number>();
const pendingGitRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
// When several sessions' throttle windows expire in the same tick, coalesce
// their nonce bumps into one `set()` instead of one per session, so a burst of
// concurrent refreshes triggers a single store update + render pass. Per-session
// timing is unchanged — only the store writes are batched.
export const queuedGitNonceBumps = new Set<string>();
let gitNonceFlushScheduled = false;

export function flushGitNonceBumps(set: GitNonceSetter) {
  gitNonceFlushScheduled = false;
  if (queuedGitNonceBumps.size === 0) return;
  const ids = [...queuedGitNonceBumps];
  queuedGitNonceBumps.clear();
  set((state) => {
    const gitNonce = { ...state.gitNonce };
    for (const id of ids) gitNonce[id] = getNumberRecordValue(gitNonce, id) + 1;
    return { gitNonce };
  });
}

export function bumpGitNonce(id: string, set: GitNonceSetter) {
  queuedGitNonceBumps.add(id);
  if (gitNonceFlushScheduled) return;
  gitNonceFlushScheduled = true;
  queueMicrotask(() => flushGitNonceBumps(set));
}

export function cancelPendingGitRefresh(id: string) {
  const timer = pendingGitRefreshTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingGitRefreshTimers.delete(id);
  }
  lastGitRefreshAt.delete(id);
}

export function clearQueuedGitNonceBump(id: string) {
  queuedGitNonceBumps.delete(id);
}

export function scheduleGitRefresh(id: string, set: GitNonceSetter) {
  const now = Date.now();
  const last = lastGitRefreshAt.get(id) ?? 0;
  const elapsed = now - last;
  if (elapsed >= GIT_REFRESH_THROTTLE_MS) {
    lastGitRefreshAt.set(id, now);
    const pending = pendingGitRefreshTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      pendingGitRefreshTimers.delete(id);
    }
    bumpGitNonce(id, set);
    return;
  }
  if (pendingGitRefreshTimers.has(id)) return;
  const timer = setTimeout(() => {
    pendingGitRefreshTimers.delete(id);
    lastGitRefreshAt.set(id, Date.now());
    bumpGitNonce(id, set);
  }, GIT_REFRESH_THROTTLE_MS - elapsed);
  pendingGitRefreshTimers.set(id, timer);
}