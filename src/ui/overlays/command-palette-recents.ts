export interface RecentTerminalDir {
  dir: string;
  label: string;
}

export interface RecentTerminalCommand {
  command: string;
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

export function collectRecentTerminalCommands(
  recentCommands: string[],
  activeCommand: string | undefined,
  limit = 5,
): RecentTerminalCommand[] {
  const active = activeCommand?.trim();
  const seen = new Set<string>();
  return recentCommands
    .flatMap((value) => {
      const command = value.trim();
      if (!command || /[\r\n]/.test(command) || command === active || seen.has(command)) return [];
      seen.add(command);
      return [{ command, label: command.length > 60 ? command.slice(0, 60) + "..." : command }];
    })
    .slice(0, limit);
}

function formatRecentDirLabel(dir: string): string {
  if (dir === "~") return "~";
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed.split("/").filter(Boolean).pop() || dir;
}
