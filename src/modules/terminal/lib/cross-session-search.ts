import { findCommandBlockAtRow, normalizeBlockCommand, type TerminalCommandBlock } from "./terminal-blocks.ts";

export interface TerminalSearchOptions {
  regex: boolean;
  caseSensitive: boolean;
}

export interface TerminalSearchSpan {
  start: number;
  end: number;
}

export type TerminalSearchMatcher = (line: string) => TerminalSearchSpan | null;

export type CompiledTerminalSearch =
  | { ok: true; find: TerminalSearchMatcher }
  | { ok: false; reason: "empty" | "invalid-regex" };

type SearchBlock = Pick<TerminalCommandBlock, "command" | "startRow" | "endRow" | "startMarker" | "endMarker">;

/** One in-memory terminal buffer. Rows are absolute xterm buffer rows. */
export interface TerminalSearchSource {
  sessionId: string;
  lineCount: number;
  readLine: (row: number) => string | null | undefined;
  blocks?: readonly SearchBlock[];
}

export interface TerminalSearchMatch {
  sessionId: string;
  row: number;
  start: number;
  end: number;
  text: string;
}

export interface TerminalSearchResultItem extends TerminalSearchMatch {
  command: string | null;
}

export interface TerminalSearchGroup {
  sessionId: string;
  matches: TerminalSearchResultItem[];
}

export interface TerminalSearchSnapshot {
  matches: TerminalSearchMatch[];
  scannedLines: number;
  truncated: boolean;
  done: boolean;
}

export interface TerminalSearchRunOptions {
  maxResults?: number;
  maxResultsPerSession?: number;
  /** Wall-clock budget of one synchronous slice before yielding to the host. */
  sliceBudgetMs?: number;
  now?: () => number;
  yieldToHost?: () => Promise<void>;
  isCancelled?: () => boolean;
  onProgress?: (snapshot: TerminalSearchSnapshot) => void;
}

export interface TerminalSearchOutcome extends TerminalSearchSnapshot {
  cancelled: boolean;
}

export const TERMINAL_SEARCH_MAX_RESULTS = 500;
export const TERMINAL_SEARCH_MAX_RESULTS_PER_SESSION = 200;
export const TERMINAL_SEARCH_SLICE_BUDGET_MS = 8;
const TIME_CHECK_INTERVAL = 256;

export function compileTerminalSearch(query: string, options: TerminalSearchOptions): CompiledTerminalSearch {
  if (!query) return { ok: false, reason: "empty" };
  if (options.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, options.caseSensitive ? "g" : "gi");
    } catch {
      return { ok: false, reason: "invalid-regex" };
    }
    return {
      ok: true,
      find: (line) => {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (match[0].length > 0) return { start: match.index, end: match.index + match[0].length };
          // Zero-width matches (`^`, lookarounds) never identify a location.
          pattern.lastIndex = match.index + 1;
          if (pattern.lastIndex > line.length) break;
        }
        return null;
      },
    };
  }
  if (options.caseSensitive) {
    return {
      ok: true,
      find: (line) => {
        const index = line.indexOf(query);
        return index < 0 ? null : { start: index, end: index + query.length };
      },
    };
  }
  const needle = query.toLowerCase();
  return {
    ok: true,
    find: (line) => {
      const lowered = line.toLowerCase();
      const index = lowered.indexOf(needle);
      if (index < 0) return null;
      // Some case mappings change string length; keep offsets inside the line.
      const start = Math.min(index, line.length);
      return { start, end: Math.min(line.length, start + needle.length) };
    },
  };
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scan terminal buffers newest-row-first, one session after another, yielding
 * to the host between bounded slices so typing and PTY output keep flowing.
 */
export async function searchTerminalSources(
  sources: readonly TerminalSearchSource[],
  find: TerminalSearchMatcher,
  {
    maxResults = TERMINAL_SEARCH_MAX_RESULTS,
    maxResultsPerSession = TERMINAL_SEARCH_MAX_RESULTS_PER_SESSION,
    sliceBudgetMs = TERMINAL_SEARCH_SLICE_BUDGET_MS,
    now = () => performance.now(),
    yieldToHost = defaultYield,
    isCancelled = () => false,
    onProgress,
  }: TerminalSearchRunOptions = {},
): Promise<TerminalSearchOutcome> {
  const matches: TerminalSearchMatch[] = [];
  let scannedLines = 0;
  let truncated = false;
  let sliceStart = now();
  let sinceCheck = 0;
  let reportedCount = -1;

  const snapshot = (done: boolean): TerminalSearchSnapshot => ({ matches: matches.slice(), scannedLines, truncated, done });

  for (const source of sources) {
    let sessionCount = 0;
    for (let row = source.lineCount - 1; row >= 0; row -= 1) {
      if (++sinceCheck >= TIME_CHECK_INTERVAL) {
        sinceCheck = 0;
        if (now() - sliceStart >= sliceBudgetMs) {
          if (onProgress && matches.length !== reportedCount) {
            reportedCount = matches.length;
            onProgress(snapshot(false));
          }
          await yieldToHost();
          if (isCancelled()) return { ...snapshot(false), cancelled: true };
          sliceStart = now();
        }
      }
      scannedLines += 1;
      const text = source.readLine(row);
      if (!text) continue;
      const span = find(text);
      if (!span) continue;
      matches.push({ sessionId: source.sessionId, row, start: span.start, end: span.end, text });
      sessionCount += 1;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      if (sessionCount >= maxResultsPerSession) {
        truncated = true;
        break;
      }
    }
    if (matches.length >= maxResults) break;
  }
  if (isCancelled()) return { ...snapshot(false), cancelled: true };
  const final = snapshot(true);
  onProgress?.(final);
  return { ...final, cancelled: false };
}

/** Group matches by session in source order and attach the owning command block. */
export function groupTerminalSearchMatches(
  matches: readonly TerminalSearchMatch[],
  sources: readonly Pick<TerminalSearchSource, "sessionId" | "blocks">[],
): TerminalSearchGroup[] {
  const bySession = new Map<string, TerminalSearchResultItem[]>();
  const blocksBySession = new Map(sources.map((source) => [source.sessionId, source.blocks ?? []]));
  for (const match of matches) {
    const blocks = blocksBySession.get(match.sessionId) ?? [];
    const block = blocks.length > 0 ? findCommandBlockAtRow(blocks as readonly TerminalCommandBlock[], match.row) : null;
    const command = block ? normalizeBlockCommand(block.command) : "";
    const list = bySession.get(match.sessionId) ?? [];
    list.push({ ...match, command: command || null });
    bySession.set(match.sessionId, list);
  }
  const order = sources.map((source) => source.sessionId);
  return [...bySession.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([sessionId, items]) => ({ sessionId, matches: items }));
}

export interface TerminalSearchSnippet {
  before: string;
  match: string;
  after: string;
}

/** Trim a long terminal row to a readable window around the match. */
export function buildTerminalSearchSnippet(text: string, span: TerminalSearchSpan, radius = 48): TerminalSearchSnippet {
  const start = Math.max(0, Math.min(span.start, text.length));
  const end = Math.max(start, Math.min(span.end, text.length));
  const fromIndex = Math.max(0, start - radius);
  const toIndex = Math.min(text.length, end + radius);
  let before = text.slice(fromIndex, start);
  let after = text.slice(end, toIndex);
  before = fromIndex > 0 ? `…${before.trimStart()}` : before.trimStart();
  after = toIndex < text.length ? `${after.trimEnd()}…` : after.trimEnd();
  return { before, match: text.slice(start, end), after };
}

export interface TerminalSearchCell {
  chars: string;
  width: number;
}

/**
 * Map a string offset from `translateToString(true)` back to a buffer cell
 * column. Wide glyphs occupy two cells, their trailing cell reports width 0,
 * and empty cells translate to a single space.
 */
export function stringOffsetToCellColumn(
  cellCount: number,
  getCell: (column: number) => TerminalSearchCell | null | undefined,
  offset: number,
): number {
  let consumed = 0;
  for (let column = 0; column < cellCount; column += 1) {
    const cell = getCell(column);
    if (!cell) return column;
    if (cell.width === 0) continue;
    const length = cell.chars.length || 1;
    if (consumed + length > offset) return column;
    consumed += length;
  }
  return cellCount;
}

/** Latest-wins scheduler: starting a new run cancels every earlier one. */
export function createLatestSearchRunner() {
  let generation = 0;
  return {
    begin(): { isCancelled: () => boolean } {
      const current = ++generation;
      return { isCancelled: () => current !== generation };
    },
    cancel() {
      generation += 1;
    },
  };
}
