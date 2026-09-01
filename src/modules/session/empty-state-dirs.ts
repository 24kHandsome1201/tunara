import type { RecentTerminalDir } from "../../ui/overlays/command-palette-recents.ts";
import { collectRecentTerminalDirs } from "../../ui/overlays/command-palette-recents.ts";

export interface NearbyGitRepo {
  path: string;
  name: string;
  mtime: number;
}

export function nearbyReposNotInRecents(
  recents: readonly RecentTerminalDir[],
  suggested: readonly NearbyGitRepo[],
  limit = 6,
): NearbyGitRepo[] {
  const seen = new Set(recents.map((entry) => normalizeDir(entry.dir)));
  const out: NearbyGitRepo[] = [];
  if (!Array.isArray(suggested)) return out;
  for (const repo of suggested) {
    const path = repo.path.trim();
    if (!path) continue;
    const key = normalizeDir(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path,
      name: repo.name.trim() || path.split("/").filter(Boolean).pop() || path,
      mtime: repo.mtime,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function emptyStateRecentDirs(recentDirs: string[], limit = 3): RecentTerminalDir[] {
  return collectRecentTerminalDirs(recentDirs, undefined, limit);
}

function normalizeDir(dir: string): string {
  if (dir === "~") return "~";
  return dir.replace(/\/+$/, "") || dir;
}
