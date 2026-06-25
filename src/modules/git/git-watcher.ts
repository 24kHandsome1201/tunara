import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";
import { gitWatch, gitUnwatch } from "./git-bridge";
import { createWatchRefCount } from "./lib/watch-refcount";
import { sameRepoPath } from "./lib/path-normalize";

interface GitChangedPayload {
  repoPath: string;
}

const refCount = createWatchRefCount({
  onFirstAcquire: (repoPath) => {
    gitWatch(repoPath).catch(() => {
      // Watcher startup failed (e.g. permission, path missing). Fall back silently;
      // the throttled refreshGit polling already covers correctness.
    });
  },
  onLastRelease: (repoPath) => {
    gitUnwatch(repoPath).catch(() => {});
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
    const target = e.payload.repoPath;
    if (!target) return;
    const store = useSessionsStore.getState();
    for (const session of store.sessions) {
      if (session.dir && sameRepoPath(session.dir, target)) {
        store.refreshGit(session.id);
      }
    }
  });
}
