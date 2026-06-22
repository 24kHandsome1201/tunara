export const RECENT_DIR_LIMIT = 20;

export function pushRecentDir(dirs: string[], dir: string | undefined, limit = RECENT_DIR_LIMIT): string[] {
  const normalized = dir?.trim();
  if (!normalized) return dirs;
  return [normalized, ...dirs.filter((d) => d !== normalized)].slice(0, limit);
}

export function sanitizeRecentDirs(value: unknown, limit = RECENT_DIR_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const dirs: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const dir = item.trim();
    if (!dir || dirs.includes(dir)) continue;
    dirs.push(dir);
    if (dirs.length >= limit) break;
  }
  return dirs;
}
