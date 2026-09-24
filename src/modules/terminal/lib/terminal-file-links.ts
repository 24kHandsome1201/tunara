import type { IBufferLine, IDisposable, ILink, Terminal } from "@xterm/xterm";
import type { ResourceRef } from "@/modules/resources/resource-ref";
import { openResource } from "@/modules/resources/resource-ref";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { findTerminalFileLinkMatches, resolveTerminalFileLinkPath } from "./terminal-file-link-parser";

interface TerminalFileLinkOptions {
  getCwd: (bufferLineNumber: number) => string | undefined;
  shouldActivate?: (event: MouseEvent) => boolean;
  /** Returns null when the owning session is gone; the link is then ignored. */
  createResource: (path: string, line?: number, column?: number) => ResourceRef | null;
}

/** A clicked link that cannot open (stale owner/binding, editor launch error) must say so. */
export function reportTerminalFileLinkOpenFailure(resource: ResourceRef, error: unknown): void {
  console.warn("[terminal-file-links] open failed", resource.path, error);
  // A stale owner has no session to focus; keep the toast app-level then.
  const ownerExists = useSessionsStore.getState().sessions.some((session) => session.id === resource.logicalSessionId);
  useUIStore.getState().addToast({
    ...(ownerExists ? { sessionId: resource.logicalSessionId } : {}),
    title: t("terminal.file_link.open_failed"),
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
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const matches = findTerminalFileLinkMatches(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((match) => ({
        text: match.text,
        range: {
          start: { x: stringOffsetToBufferX(line, match.startIndex, false), y: bufferLineNumber },
          end: { x: stringOffsetToBufferX(line, match.endIndex, true), y: bufferLineNumber },
        },
        decorations: { pointerCursor: true, underline: true },
        activate(event) {
          if (options.shouldActivate && !options.shouldActivate(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const path = resolveTerminalFileLinkPath(match.rawPath, options.getCwd(bufferLineNumber));
          const resource = options.createResource(path, match.line, match.column);
          if (resource) void openResource(resource).catch((error) => reportTerminalFileLinkOpenFailure(resource, error));
        },
      }));
      callback(links);
    },
  });
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
