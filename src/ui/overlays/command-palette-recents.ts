export interface RecentTerminalDir {
  dir: string;
  label: string;
}

export function collectRecentTerminalDirs(
  recentDirs: string[],
  activeDir: string | undefined,
  limit = 5,
): RecentTerminalDir[] {
  const seen = new Set<string>();
  return recentDirs
    .flatMap((value) => {
      const dir = value.trim();
      if (!dir || dir === activeDir || seen.has(dir)) return [];
      seen.add(dir);
      return [{ dir, label: formatRecentDirLabel(dir) }];
    })
    .slice(0, limit);
}

function formatRecentDirLabel(dir: string): string {
  if (dir === "~") return "~";
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).pop() || dir;
}
