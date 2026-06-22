export interface TerminalBlockFilterOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  invert: boolean;
  contextLines: number;
}

export interface TerminalBlockFilterLine {
  index: number;
  text: string;
  selected: boolean;
  context: boolean;
  rawMatch: boolean;
}

export interface TerminalBlockFilterResult {
  lines: TerminalBlockFilterLine[];
  selectedCount: number;
  totalLines: number;
  invalidRegex: boolean;
}

function splitOutputLines(output: string): string[] {
  if (!output) return [];
  return output.split(/\r\n|\r|\n/);
}

function clampContextLines(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.trunc(value)));
}

function createLineMatcher(query: string, regex: boolean, caseSensitive: boolean): ((line: string) => boolean) | null {
  if (!query) return null;
  if (regex) {
    const pattern = new RegExp(query, caseSensitive ? "" : "i");
    return (line) => pattern.test(line);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

export function filterTerminalBlockOutput(
  output: string,
  options: TerminalBlockFilterOptions,
): TerminalBlockFilterResult {
  const lines = splitOutputLines(output);
  const query = options.query.trim();
  if (!query) {
    return {
      lines: lines.map((text, index) => ({ index, text, selected: false, context: false, rawMatch: false })),
      selectedCount: 0,
      totalLines: lines.length,
      invalidRegex: false,
    };
  }

  let matcher: ((line: string) => boolean) | null = null;
  try {
    matcher = createLineMatcher(query, options.regex, options.caseSensitive);
  } catch {
    return { lines: [], selectedCount: 0, totalLines: lines.length, invalidRegex: true };
  }

  const context = clampContextLines(options.contextLines);
  const selected = new Set<number>();
  const rawMatches = new Set<number>();
  lines.forEach((line, index) => {
    const rawMatch = matcher?.(line) ?? false;
    if (rawMatch) rawMatches.add(index);
    if (options.invert ? !rawMatch : rawMatch) selected.add(index);
  });

  const included = new Set<number>();
  for (const index of selected) {
    for (let row = Math.max(0, index - context); row <= Math.min(lines.length - 1, index + context); row += 1) {
      included.add(row);
    }
  }

  return {
    lines: [...included].sort((a, b) => a - b).map((index) => ({
      index,
      text: lines[index],
      selected: selected.has(index),
      context: !selected.has(index),
      rawMatch: rawMatches.has(index),
    })),
    selectedCount: selected.size,
    totalLines: lines.length,
    invalidRegex: false,
  };
}

export function formatTerminalBlockFilterText(result: TerminalBlockFilterResult): string {
  return result.lines.map((line) => line.text).join("\n");
}
