export const RECENT_COMMAND_LIMIT = 30;

export function pushRecentCommand(
  commands: string[],
  command: string | undefined,
  limit = RECENT_COMMAND_LIMIT,
): string[] {
  const normalized = normalizeRecentCommand(command);
  if (!normalized) return commands;
  return [normalized, ...commands.filter((item) => item !== normalized)].slice(0, limit);
}

export function sanitizeRecentCommands(value: unknown, limit = RECENT_COMMAND_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const command = normalizeRecentCommand(item);
    if (!command || commands.includes(command)) continue;
    commands.push(command);
    if (commands.length >= limit) break;
  }
  return commands;
}

function normalizeRecentCommand(command: string | undefined): string | null {
  const normalized = command?.trim();
  if (!normalized || /[\r\n]/.test(normalized)) return null;
  return normalized;
}
