import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";
import { gitWatch, gitUnwatch } from "./git-bridge";
import { createWatchRefCount } from "./lib/watch-refcount";
import { sameRepoPath } from "./lib/path-normalize";

interface GitChangedPayload {
  repoPath: string;
}

const WATCH_FALLBACK_POLL_MS = 5_000;
const activeRepos = new Set<string>();
const fallbackPollers = new Map<string, ReturnType<typeof setInterval>>();

function refreshSessionsForRepo(repoPath: string): void {
  if (!repoPath) return;
  const store = useSessionsStore.getState();
  for (const session of store.sessions) {
    if (session.remote) continue;
    if (session.dir && sameRepoPath(session.dir, repoPath)) {
      store.refreshGit(session.id);
    }
  }
}

function startFallbackPoller(repoPath: string): void {
  if (!activeRepos.has(repoPath) || fallbackPollers.has(repoPath)) return;
  fallbackPollers.set(repoPath, setInterval(() => refreshSessionsForRepo(repoPath), WATCH_FALLBACK_POLL_MS));
}

function stopFallbackPoller(repoPath: string): void {
  const timer = fallbackPollers.get(repoPath);
  if (!timer) return;
  clearInterval(timer);
  fallbackPollers.delete(repoPath);
}

function releaseBackendWatch(repoPath: string): void {
  gitUnwatch(repoPath).catch(() => {});
}

const refCount = createWatchRefCount({
  onFirstAcquire: (repoPath) => {
    activeRepos.add(repoPath);
    gitWatch(repoPath)
      .then(() => {
        if (activeRepos.has(repoPath)) {
          stopFallbackPoller(repoPath);
        } else {
          releaseBackendWatch(repoPath);
        }
      })
      .catch(() => {
        // Watcher startup can fail on permission or platform limits. Keep the
        // review rail eventually fresh without turning the healthy path into polling.
        startFallbackPoller(repoPath);
      });
  },
  onLastRelease: (repoPath) => {
    activeRepos.delete(repoPath);
    stopFallbackPoller(repoPath);
    releaseBackendWatch(repoPath);
  },
});

export function acquireGitWatch(repoPath: string): void {
  refCount.acquire(repoPath);
}

export function releaseGitWatch(repoPath: string): void {
  refCount.release(repoPath);
}

export async function startGitWatcherListener(): Promise<UnlistenFn> {
  return listen<GitChangedPayload>("git-changed", (e) => {
    refreshSessionsForRepo(e.payload.repoPath);
  });
}
