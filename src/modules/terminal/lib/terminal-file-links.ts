import { type IBufferLine, type IDisposable, type ILink, type Terminal } from "@xterm/xterm";
import { openInEditor } from "@/modules/editor/open";
import { findTerminalFileLinkMatches, resolveTerminalFileLinkPath } from "./terminal-file-link-parser";

interface TerminalFileLinkOptions {
  getCwd: () => string | undefined;
  getEditor: () => string;
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
          event.preventDefault();
          event.stopPropagation();
          const path = resolveTerminalFileLinkPath(match.rawPath, options.getCwd());
          openInEditor(options.getEditor(), path, match.line, match.column).catch(() => {});
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
