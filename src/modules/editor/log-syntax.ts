export type LogSyntaxKind =
  | "text"
  | "log-timestamp"
  | "log-error"
  | "log-warn"
  | "log-debug"
  | "log-ip"
  | "log-url"
  | "log-string"
  | "log-number";

export interface LogSyntaxSegment {
  kind: LogSyntaxKind;
  text: string;
}

interface SyntaxRange {
  start: number;
  end: number;
  kind: Exclude<LogSyntaxKind, "text">;
}

const ISO_TIMESTAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const SYSLOG_TIMESTAMP =
  /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?/g;
const NGINX_TIMESTAMP = /\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\]/g;
const LEVEL_ERROR = /\b(?:ERROR|FATAL|CRITICAL|PANIC|Traceback)\b/g;
const LEVEL_WARN = /\bWARN(?:ING)?\b/g;
const LEVEL_DEBUG = /\b(?:DEBUG|TRACE)\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 =
  /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{0,4}\b|\b::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b|\b::(?:ffff:)?(?:\d{1,3}\.){3}\d{1,3}\b|\b::1\b/g;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const QUOTED = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
const NUMBER = /\b\d+(?:\.\d+)?\b/g;

function addRange(ranges: SyntaxRange[], range: SyntaxRange) {
  if (range.start >= range.end) return;
  if (ranges.some((existing) => range.start < existing.end && range.end > existing.start)) return;
  ranges.push(range);
}

function addMatches(line: string, ranges: SyntaxRange[], expression: RegExp, kind: SyntaxRange["kind"]) {
  expression.lastIndex = 0;
  for (const match of line.matchAll(expression)) {
    if (match.index === undefined) continue;
    addRange(ranges, { start: match.index, end: match.index + match[0].length, kind });
  }
}

function segmentsFromRanges(line: string, ranges: SyntaxRange[]): LogSyntaxSegment[] {
  if (line.length === 0) return [{ kind: "text", text: "" }];
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const segments: LogSyntaxSegment[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) segments.push({ kind: "text", text: line.slice(offset, range.start) });
    segments.push({ kind: range.kind, text: line.slice(range.start, range.end) });
    offset = range.end;
  }
  if (offset < line.length) segments.push({ kind: "text", text: line.slice(offset) });
  return segments;
}

function highlightLogLine(line: string): LogSyntaxSegment[] {
  const ranges: SyntaxRange[] = [];
  addMatches(line, ranges, ISO_TIMESTAMP, "log-timestamp");
  addMatches(line, ranges, SYSLOG_TIMESTAMP, "log-timestamp");
  addMatches(line, ranges, NGINX_TIMESTAMP, "log-timestamp");
  addMatches(line, ranges, LEVEL_ERROR, "log-error");
  addMatches(line, ranges, LEVEL_WARN, "log-warn");
  addMatches(line, ranges, LEVEL_DEBUG, "log-debug");
  addMatches(line, ranges, URL, "log-url");
  addMatches(line, ranges, IPV4, "log-ip");
  addMatches(line, ranges, IPV6, "log-ip");
  addMatches(line, ranges, QUOTED, "log-string");
  addMatches(line, ranges, NUMBER, "log-number");
  return segmentsFromRanges(line, ranges);
}

export function highlightLogSource(content: string): LogSyntaxSegment[][] {
  return content.split("\n").map(highlightLogLine);
}
