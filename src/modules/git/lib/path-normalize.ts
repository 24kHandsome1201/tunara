export function normalizeRepoPath(path: string): string {
  return path.replace(/\/+$/, "");
}

export function sameRepoPath(a: string, b: string): boolean {
  return normalizeRepoPath(a) === normalizeRepoPath(b);
}
