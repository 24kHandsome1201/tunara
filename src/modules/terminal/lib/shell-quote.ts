export const DROPPED_PATH_LIMIT = 16;

/** Quote a token for POSIX shells without wrapping safe unquoted paths. */
export function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9._:@%/+=,-]+$/.test(token)
    ? token
    : `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Turn dropped filesystem paths into text a local PTY can insert.
 * A leading space matches Terminal/iTerm so the drop can append to a typed command.
 */
export function formatDroppedTerminalPaths(paths: readonly string[], limit = DROPPED_PATH_LIMIT): string | null {
  const quoted: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || /[\0\r\n]/.test(path)) continue;
    quoted.push(shellQuoteToken(path));
    if (quoted.length >= limit) break;
  }
  if (quoted.length === 0) return null;
  return ` ${quoted.join(" ")}`;
}
