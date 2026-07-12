export type MarkdownSyntaxKind =
  | "text"
  | "marker"
  | "heading"
  | "code"
  | "link"
  | "tag"
  | "value";

export interface MarkdownSyntaxSegment {
  kind: MarkdownSyntaxKind;
  text: string;
}

interface SyntaxRange {
  start: number;
  end: number;
  kind: Exclude<MarkdownSyntaxKind, "text">;
}

function addRange(ranges: SyntaxRange[], range: SyntaxRange) {
  if (range.start >= range.end) return;
  if (ranges.some((existing) => range.start < existing.end && range.end > existing.start)) return;
  ranges.push(range);
}

function addMatches(
  line: string,
  ranges: SyntaxRange[],
  expression: RegExp,
  kind: Exclude<MarkdownSyntaxKind, "text">,
  group = 0,
) {
  expression.lastIndex = 0;
  for (const match of line.matchAll(expression)) {
    const value = match[group];
    if (!value || match.index === undefined) continue;
    const relative = group === 0 ? 0 : match[0].indexOf(value);
    const start = match.index + Math.max(relative, 0);
    addRange(ranges, { start, end: start + value.length, kind });
  }
}

function segmentsFromRanges(line: string, ranges: SyntaxRange[]): MarkdownSyntaxSegment[] {
  if (line.length === 0) return [{ kind: "text", text: "" }];
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const segments: MarkdownSyntaxSegment[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) segments.push({ kind: "text", text: line.slice(offset, range.start) });
    segments.push({ kind: range.kind, text: line.slice(range.start, range.end) });
    offset = range.end;
  }
  if (offset < line.length) segments.push({ kind: "text", text: line.slice(offset) });
  return segments;
}

export function highlightMarkdownSource(content: string): MarkdownSyntaxSegment[][] {
  let fence: "`" | "~" | null = null;
  return content.split("\n").map((line) => {
    const ranges: SyntaxRange[] = [];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const markerStart = line.indexOf(fenceMatch[1]);
      const marker = fenceMatch[1][0] as "`" | "~";
      const closesFence = fence === marker;
      if (fence === null || closesFence) {
        addRange(ranges, { start: markerStart, end: markerStart + fenceMatch[1].length, kind: "marker" });
        if (fenceMatch[2]) {
          addRange(ranges, {
            start: markerStart + fenceMatch[1].length,
            end: line.length,
            kind: "value",
          });
        }
        fence = closesFence ? null : marker;
        return segmentsFromRanges(line, ranges);
      }
    }

    if (fence !== null) return [{ kind: "code", text: line }];

    const heading = line.match(/^\s{0,3}(#{1,6})(\s+)/);
    if (heading) {
      const start = line.indexOf(heading[1]);
      addRange(ranges, { start, end: start + heading[1].length, kind: "heading" });
    }
    const quote = line.match(/^\s{0,3}(>)(?:\s|$)/);
    if (quote) addRange(ranges, { start: line.indexOf(quote[1]), end: line.indexOf(quote[1]) + 1, kind: "marker" });
    const list = line.match(/^\s{0,3}([-+*]|\d+[.)])(?=\s)/);
    if (list) {
      const start = line.indexOf(list[1]);
      addRange(ranges, { start, end: start + list[1].length, kind: "marker" });
    }

    addMatches(line, ranges, /`+[^`\n]+`+/g, "code");
    addMatches(line, ranges, /<\/?[A-Za-z][^>\n]*>/g, "tag");
    addMatches(line, ranges, /\[[^\]\n]+\]\([^)\n]+\)/g, "link");
    addMatches(line, ranges, /https?:\/\/[^\s>)]+/g, "link");
    addMatches(line, ranges, /(?:^|\s)([-*_])(?:\s*\1){2,}\s*$/g, "marker", 1);
    addMatches(line, ranges, /\*\*|__|~~|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g, "marker");
    addMatches(line, ranges, /\{[^{}\n]+\}/g, "value");

    return segmentsFromRanges(line, ranges);
  });
}
