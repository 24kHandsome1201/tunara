const NOISE_COMMANDS = new Set([
  "ls", "ll", "la", "l", "dir",
  "cd", "pushd", "popd",
  "pwd", "whoami", "hostname",
  "cat", "head", "tail", "less", "more", "bat",
  "clear", "reset", "cls",
  "echo", "printf", "true", "false",
  "exit", "logout",
  "history", "which", "where", "type", "file",
  "source", ".", "export", "unset", "alias", "unalias",
]);

export function isMeaningfulCommand(command: string): boolean {
  const cmd = command.split(/\s+/)[0]?.toLowerCase() ?? "";
  return !NOISE_COMMANDS.has(cmd);
}
