export const RECENT_DIR_LIMIT = 20;

export function pushRecentDir(dirs: string[], dir: string | undefined, limit = RECENT_DIR_LIMIT): string[] {
  if (!dir || !dir.trim()) return dirs;
  return [dir, ...dirs.filter((d) => d !== dir)].slice(0, limit);
}

export function sanitizeRecentDirs(value: unknown, limit = RECENT_DIR_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const dirs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!item.trim() || dirs.includes(item)) continue;
    dirs.push(item);
    if (dirs.length >= limit) break;
  }
  return dirs;
}
