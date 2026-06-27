export function normalizeRepoPath(path: string): string {
  const withoutTrailingSlashes = path.replace(/\/+$/, "");
  if (!withoutTrailingSlashes && path.startsWith("/")) return "/";
  return withoutTrailingSlashes;
}

export function sameRepoPath(a: string, b: string): boolean {
  return normalizeRepoPath(a) === normalizeRepoPath(b);
}

export function normalizeLocalRepoPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = normalizeRepoPath(path);
  return normalized.startsWith("/") || normalized.startsWith("~/") ? normalized : null;
}
