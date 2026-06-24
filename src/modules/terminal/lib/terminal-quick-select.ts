import { findTerminalFileLinkMatches, resolveTerminalFileLinkPath } from "./terminal-file-link-parser.ts";

export const TERMINAL_QUICK_SELECT_EVENT = "tunara:terminal-quick-select";

export type TerminalQuickSelectKind = "url" | "file" | "text";

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
const GIT_HASH_RE = /\b[0-9a-f]{7,40}\b/gi;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;

interface TextRange {
  start: number;
  end: number;
}

interface QuickSelectTextToken extends TextRange {
  text: string;
  detail: string;
}

interface QuickSelectUrlToken extends TextRange {
  text: string;
}

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
  return findTerminalUrlMatches(text).map((match) => match.text);
}

function findTerminalUrlMatches(text: string): QuickSelectUrlToken[] {
  URL_RE.lastIndex = 0;
  const tokens: QuickSelectUrlToken[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const token = trimUrlToken(match[0]);
    const start = match.index ?? 0;
    if (token) tokens.push({ text: token, start, end: start + token.length });
  }
  return tokens;
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function isRangeFree(range: TextRange, occupied: readonly TextRange[]): boolean {
  return !occupied.some((item) => rangesOverlap(range, item));
}

function addTextTokens(
  tokens: QuickSelectTextToken[],
  occupied: TextRange[],
  text: string,
  pattern: RegExp,
  detail: string,
  accept: (token: string) => boolean = () => true,
) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    const start = match.index ?? 0;
    const range = { start, end: start + value.length };
    if (!accept(value) || !isRangeFree(range, occupied)) continue;
    occupied.push(range);
    tokens.push({ ...range, text: value, detail });
  }
}

export function findTerminalQuickSelectTextTokens(text: string, occupied: readonly TextRange[] = []): QuickSelectTextToken[] {
  const tokens: QuickSelectTextToken[] = [];
  const used = [...occupied];
  addTextTokens(tokens, used, text, GIT_HASH_RE, "Git hash", (token) => /[a-f]/i.test(token));
  addTextTokens(tokens, used, text, IPV4_RE, "IP address");
  addTextTokens(tokens, used, text, NUMBER_RE, "Number");
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
    const occupiedRanges: TextRange[] = [];
    for (const url of findTerminalUrlMatches(lineText)) {
      occupiedRanges.push(url);
      push({
        id: `url:${url.text}`,
        kind: "url",
        label: url.text,
        detail: hostLabel(url.text),
        copyText: url.text,
        target: url.text,
      });
    }

    for (const match of findTerminalFileLinkMatches(lineText)) {
      const target = resolveTerminalFileLinkPath(match.rawPath, cwd);
      occupiedRanges.push({ start: match.startIndex, end: match.startIndex + match.text.length });
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

    for (const token of findTerminalQuickSelectTextTokens(lineText, occupiedRanges)) {
      push({
        id: `text:${token.detail}:${token.text}`,
        kind: "text",
        label: token.text,
        detail: token.detail,
        copyText: token.text,
        target: token.text,
      });
    }
  }

  return items;
}
