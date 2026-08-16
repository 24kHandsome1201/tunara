export function isRemoteAbsolutePath(path: string | undefined): path is string {
  return typeof path === "string" && path.startsWith("/") && path.length > 1 && !path.includes("\0");
}

/** OSC-7 remote cwd when known; otherwise null so the explorer keeps its last path. */
export function remoteExplorerFollowPath(session: { remote?: unknown; dir: string } | null | undefined): string | null {
  if (!session?.remote) return null;
  return isRemoteAbsolutePath(session.dir) ? session.dir : null;
}

export function terminalUploadDestination(cwd: string | undefined, fileName: string): string | null {
  if (!isRemoteAbsolutePath(cwd) || !fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("\0")) {
    return null;
  }
  const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${root}/${fileName}`;
}
