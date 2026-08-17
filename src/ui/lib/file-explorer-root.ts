/**
 * OSC 7 gives remote POSIX shells an absolute working directory. Older saved
 * SSH sessions only have a user@host label, so those still need an SFTP home
 * lookup before the explorer can open.
 */
export function knownRemoteExplorerRoot(rootDir: string): string | null {
  const trimmed = rootDir.trim();
  return trimmed.startsWith("/") ? trimmed : null;
}

/** SSH listings always start at the remote filesystem root, not the session cwd. */
export function remoteExplorerListingRoot(): "/" {
  return "/";
}

export function remoteExplorerSearchRoot(currentPath: string, homeDir: string | null): string {
  if (currentPath.startsWith("/") && currentPath !== "/") return currentPath;
  if (homeDir && homeDir.startsWith("/") && homeDir !== "/") return homeDir;
  return "/";
}
