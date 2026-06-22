import { findTerminalFileLinkMatches, resolveTerminalFileLinkPath } from "./terminal-file-link-parser.ts";

export const TERMINAL_QUICK_SELECT_EVENT = "conduit:terminal-quick-select";

export type TerminalQuickSelectKind = "url" | "file";

export interface TerminalQuickSelectItem {
  id: string;
  kind: TerminalQuickSelectKind;
  label: string;
  detail: string;
  copyText: string;
  target: string;
  line?: number;
  column?: number;
}

const QUICK_SELECT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

export function quickSelectHint(index: number, alphabet = QUICK_SELECT_ALPHABET): string {
  const base = alphabet.length;
  if (base === 0 || index < 0) return "";
  if (index < base) return alphabet[index];
  const offset = index - base;
  return `${alphabet[Math.floor(offset / base) % base]}${alphabet[offset % base]}`;
}

function trimUrlToken(token: string): string {
  let text = token;
  while (/[.,;:!?]$/.test(text)) text = text.slice(0, -1);
  return text;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host || "URL";
  } catch {
    return "URL";
  }
}

export function findTerminalUrlTokens(text: string): string[] {
  URL_RE.lastIndex = 0;
  const tokens: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const token = trimUrlToken(match[0]);
    if (token) tokens.push(token);
  }
  return tokens;
}

export function collectTerminalQuickSelectItems(
  lines: readonly string[],
  cwd: string | undefined,
  limit = 80,
): TerminalQuickSelectItem[] {
  const items: TerminalQuickSelectItem[] = [];
  const seen = new Set<string>();

  const push = (item: TerminalQuickSelectItem) => {
    if (items.length >= limit || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  for (const lineText of lines) {
    for (const url of findTerminalUrlTokens(lineText)) {
      push({
        id: `url:${url}`,
        kind: "url",
        label: url,
        detail: hostLabel(url),
        copyText: url,
        target: url,
      });
    }

    for (const match of findTerminalFileLinkMatches(lineText)) {
      const target = resolveTerminalFileLinkPath(match.rawPath, cwd);
      push({
        id: `file:${target}:${match.line}:${match.column ?? 0}`,
        kind: "file",
        label: match.text,
        detail: target,
        copyText: match.text,
        target,
        line: match.line,
        column: match.column,
      });
    }
  }

  return items;
}
