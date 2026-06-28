export const SESSION_NOTE_MAX_LENGTH = 20_000;

export interface SessionNoteStats {
  chars: number;
  words: number;
  todoCount: number;
  doneCount: number;
}

export function sanitizeSessionNote(value: unknown, maxLength = SESSION_NOTE_MAX_LENGTH): string {
  if (typeof value !== "string") return "";
  const limit = Number.isFinite(maxLength) && maxLength > 0
    ? Math.floor(maxLength)
    : SESSION_NOTE_MAX_LENGTH;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

export function getSessionNoteStats(note: string): SessionNoteStats {
  const clean = sanitizeSessionNote(note);
  const trimmed = clean.trim();
  const wordText = trimmed.replace(/\[\s\]/gu, "").trim();
  const words = wordText ? wordText.split(/\s+/u).length : 0;
  let todoCount = 0;
  let doneCount = 0;

  for (const line of clean.split("\n")) {
    const match = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
    if (!match) continue;
    todoCount += 1;
    if (match[1].toLowerCase() === "x") doneCount += 1;
  }

  return {
    chars: clean.length,
    words,
    todoCount,
    doneCount,
  };
}
