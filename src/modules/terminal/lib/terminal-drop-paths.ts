export const MAX_DROPPED_TERMINAL_PATHS = 32;

/** POSIX-safe single-token quoting for inserting a local path into a shell. */
export function shellQuotePath(path: string): string {
  if (!path) return "''";
  return /^[A-Za-z0-9._:@%/+=,-]+$/.test(path)
    ? path
    : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Join dropped filesystem paths into a single insertable fragment. No trailing
 * newline — the user decides whether to submit. Returns null when nothing is
 * safe to insert.
 */
export function formatDroppedTerminalPaths(paths: readonly string[]): string | null {
  const quoted: string[] = [];
  for (const raw of paths) {
    if (quoted.length >= MAX_DROPPED_TERMINAL_PATHS) break;
    const path = raw.replace(/\u0000/g, "").trim();
    if (!path) continue;
    quoted.push(shellQuotePath(path));
  }
  if (quoted.length === 0) return null;
  return `${quoted.join(" ")} `;
}
