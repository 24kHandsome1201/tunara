import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";
import { gitWatch, gitUnwatch } from "./git-bridge";

interface GitChangedPayload {
  repoPath: string;
}

const watchCounts = new Map<string, number>();

export function acquireGitWatch(repoPath: string): void {
  if (!repoPath) return;
  const next = (watchCounts.get(repoPath) ?? 0) + 1;
  watchCounts.set(repoPath, next);
  if (next === 1) {
    gitWatch(repoPath).catch(() => {
      // Watcher startup failed (e.g. permission, path missing). Fall back silently;
      // the throttled refreshGit polling already covers correctness.
    });
  }
}

export function releaseGitWatch(repoPath: string): void {
  if (!repoPath) return;
  const current = watchCounts.get(repoPath) ?? 0;
  if (current <= 1) {
    watchCounts.delete(repoPath);
    gitUnwatch(repoPath).catch(() => {});
  } else {
    watchCounts.set(repoPath, current - 1);
  }
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

function sameRepoPath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "");
}
