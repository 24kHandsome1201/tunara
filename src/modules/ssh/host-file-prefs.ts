export const HOST_FAVORITE_LIMIT = 8;
export const HOST_RECENT_PATH_LIMIT = 12;
export const HOST_PATH_MAX_BYTES = 4_096;

export interface HostFilePrefsV1 {
  favoritePaths: string[];
  recentPaths: string[];
  lastDownloadDir?: string;
  followTerminalCwd: boolean;
}

export function hostFilePrefsKey(remote: { user: string; host: string; port: number }): string {
  return `${remote.user.trim().toLowerCase()}@${remote.host.trim().toLowerCase()}:${remote.port}`;
}

export function emptyHostFilePrefs(followTerminalCwd = true): HostFilePrefsV1 {
  return { favoritePaths: [], recentPaths: [], followTerminalCwd };
}

function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}

function isSafeRemotePath(path: string): boolean {
  if (!path.startsWith("/") || path.length > HOST_PATH_MAX_BYTES || path.includes("\0")) return false;
  return !path.split("/").slice(1).some((part) => part === "." || part === "..");
}

function isSafeLocalDir(path: string): boolean {
  if (!path || path.length > HOST_PATH_MAX_BYTES || /[\0\r\n]/.test(path)) return false;
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function uniqueBounded(paths: readonly string[], limit: number, ok: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!ok(path) || out.includes(path)) continue;
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

export function sanitizeHostFilePrefs(raw: unknown, followDefault = true): HostFilePrefsV1 {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const favoritePaths = uniqueBounded(
    Array.isArray(value.favoritePaths) ? value.favoritePaths.filter((item): item is string => typeof item === "string") : [],
    HOST_FAVORITE_LIMIT,
    isSafeRemotePath,
  );
  const recentPaths = uniqueBounded(
    Array.isArray(value.recentPaths) ? value.recentPaths.filter((item): item is string => typeof item === "string") : [],
    HOST_RECENT_PATH_LIMIT,
    isSafeRemotePath,
  );
  const lastDownloadDir = typeof value.lastDownloadDir === "string" && isSafeLocalDir(value.lastDownloadDir)
    ? value.lastDownloadDir
    : undefined;
  return {
    favoritePaths,
    recentPaths,
    ...(lastDownloadDir ? { lastDownloadDir } : {}),
    followTerminalCwd: typeof value.followTerminalCwd === "boolean" ? value.followTerminalCwd : followDefault,
  };
}

export function sanitizeHostFilePrefsMap(raw: unknown): Record<string, HostFilePrefsV1> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, HostFilePrefsV1> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeRecordKey(key) || key.length > 512 || /[\0\r\n]/.test(key)) continue;
    out[key] = sanitizeHostFilePrefs(value);
  }
  return out;
}

export function pushHostRecentPath(prefs: HostFilePrefsV1, path: string): HostFilePrefsV1 {
  if (!isSafeRemotePath(path)) return prefs;
  return {
    ...prefs,
    recentPaths: [path, ...prefs.recentPaths.filter((item) => item !== path)].slice(0, HOST_RECENT_PATH_LIMIT),
  };
}

export function toggleHostFavoritePath(prefs: HostFilePrefsV1, path: string): HostFilePrefsV1 {
  if (!isSafeRemotePath(path)) return prefs;
  if (prefs.favoritePaths.includes(path)) {
    return { ...prefs, favoritePaths: prefs.favoritePaths.filter((item) => item !== path) };
  }
  if (prefs.favoritePaths.length >= HOST_FAVORITE_LIMIT) return prefs;
  return { ...prefs, favoritePaths: [...prefs.favoritePaths, path] };
}

export function rememberHostDownloadDir(prefs: HostFilePrefsV1, path: string): HostFilePrefsV1 {
  return isSafeLocalDir(path) ? { ...prefs, lastDownloadDir: path } : prefs;
}
