import type { IBufferLine, IDisposable, ILink, Terminal } from "@xterm/xterm";
import type { ResourceRef } from "@/modules/resources/resource-ref";
import { openResource } from "@/modules/resources/resource-ref";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { isMac } from "@/ui/lib/platform";
import { findTerminalDirectoryLinkMatches, findTerminalFileLinkMatches, resolveTerminalFileLinkPath } from "./terminal-file-link-parser";

interface TerminalFileLinkOptions {
  getCwd: (bufferLineNumber: number) => string | undefined;
  shouldActivate?: (event: MouseEvent) => boolean;
  /** Returns null when the owning session is gone; the link is then ignored. */
  createResource: (path: string, line?: number, column?: number) => ResourceRef | null;
}

/** macOS turns Ctrl+click into a context-menu click, so directory links use ⌘ there. */
export function isDirectoryLinkClick(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey">, macOS = isMac): boolean {
  return event.button === 0 && (macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** A clicked link that cannot open (stale owner/binding, editor launch error) must say so. */
export function reportTerminalFileLinkOpenFailure(resource: ResourceRef, error: unknown, directory = false): void {
  console.warn("[terminal-file-links] open failed", resource.path, error);
  // A stale owner has no session to focus; keep the toast app-level then.
  const ownerExists = useSessionsStore.getState().sessions.some((session) => session.id === resource.logicalSessionId);
  useUIStore.getState().addToast({
    ...(ownerExists ? { sessionId: resource.logicalSessionId } : {}),
    title: t(directory ? "explorer.read_dir_failed" : "terminal.file_link.open_failed"),
    subtitle: resource.path,
    variant: "error",
  });
}

export function registerTerminalFileLinkProvider(
  term: Terminal,
  options: TerminalFileLinkOptions,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const logical = readLogicalLine(term, bufferLineNumber);
      if (!logical) {
        callback(undefined);
        return;
      }
      const { text, rows } = logical;
      const matches = [
        ...findTerminalFileLinkMatches(text).map((match) => ({ ...match, directory: false })),
        ...findTerminalDirectoryLinkMatches(text).map((match) => ({ ...match, line: undefined, column: undefined, directory: true })),
      ].filter((match) => rangeIncludesRow(rows, match.startIndex, match.endIndex, bufferLineNumber));
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((match) => ({
        text: match.text,
        range: {
          start: stringOffsetToBufferPosition(rows, match.startIndex, false),
          end: stringOffsetToBufferPosition(rows, match.endIndex, true),
        },
        decorations: { pointerCursor: true, underline: true },
        activate(event) {
          if (match.directory && (!isDirectoryLinkClick(event) || term.hasSelection())) return;
          if (options.shouldActivate && !options.shouldActivate(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const path = resolveTerminalFileLinkPath(match.rawPath, options.getCwd(rows[0].y));
          const resource = options.createResource(path, match.line, match.column);
          if (resource) void openResource(resource, match.directory ? "directory" : "editor").catch((error) => reportTerminalFileLinkOpenFailure(resource, error, match.directory));
        },
      }));
      callback(links);
    },
  });
}

interface LogicalLineRow {
  line: IBufferLine;
  /** 1-based buffer row, as xterm's link ranges use. */
  y: number;
  /** Offset of this row's first character in the logical line text. */
  offset: number;
}

/** Joins the soft-wrapped rows around a buffer row so a path that wraps is matched whole. */
function readLogicalLine(term: Terminal, bufferLineNumber: number): { text: string; rows: LogicalLineRow[] } | undefined {
  const buffer = term.buffer.active;
  let first = bufferLineNumber - 1;
  if (!buffer.getLine(first)) return undefined;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
  const rows: LogicalLineRow[] = [];
  let text = "";
  for (let y = first; ; y += 1) {
    const line = buffer.getLine(y);
    if (!line) break;
    const next = buffer.getLine(y + 1);
    const continues = next?.isWrapped === true;
    rows.push({ line, y: y + 1, offset: text.length });
    text += line.translateToString(!continues);
    if (!continues) break;
  }
  return { text, rows };
}

function rowIndexForOffset(rows: LogicalLineRow[], offset: number, endInclusive: boolean): number {
  let index = 0;
  while (index + 1 < rows.length && (endInclusive ? offset > rows[index + 1].offset : offset >= rows[index + 1].offset)) index += 1;
  return index;
}

function rangeIncludesRow(rows: LogicalLineRow[], startIndex: number, endIndex: number, bufferLineNumber: number): boolean {
  return rows[rowIndexForOffset(rows, startIndex, false)].y <= bufferLineNumber
    && rows[rowIndexForOffset(rows, endIndex, true)].y >= bufferLineNumber;
}

function stringOffsetToBufferPosition(rows: LogicalLineRow[], offset: number, endInclusive: boolean): { x: number; y: number } {
  const row = rows[rowIndexForOffset(rows, offset, endInclusive)];
  return { x: stringOffsetToBufferX(row.line, offset - row.offset, endInclusive), y: row.y };
}

function stringOffsetToBufferX(line: IBufferLine, offset: number, endInclusive: boolean): number {
  let stringOffset = 0;
  let lastContentX = 1;
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    const chars = cell.getChars();
    if (!chars && cell.getWidth() === 0) continue;
    const nextOffset = stringOffset + (chars ? chars.length : 1);
    if (endInclusive ? offset <= nextOffset : offset < nextOffset) return x + 1;
    stringOffset = nextOffset;
    lastContentX = x + 1;
  }
  return lastContentX;
}
