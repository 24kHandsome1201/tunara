export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function cleanTerminalText(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanTerminalLines(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}
