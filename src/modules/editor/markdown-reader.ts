export type MarkdownAlignment = "left" | "center" | "right" | null;

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string; id: string; key: string }
  | { type: "paragraph"; text: string; key: string }
  | { type: "code"; language?: string; text: string; key: string }
  | { type: "quote"; text: string; key: string }
  | { type: "unordered-list"; items: string[]; key: string }
  | { type: "ordered-list"; items: string[]; key: string }
  | { type: "table"; header: string[]; rows: string[][]; alignments: MarkdownAlignment[]; key: string }
  | { type: "rule"; key: string };

export interface MarkdownTocEntry {
  level: 1 | 2 | 3;
  text: string;
  id: string;
}

export interface ParsedMarkdownDocument {
  blocks: MarkdownBlock[];
  toc: MarkdownTocEntry[];
}

export interface SafeMarkdownLanguage {
  label: string;
  className?: string;
}

export function safeMarkdownLanguage(raw: string | undefined): SafeMarkdownLanguage | null {
  const normalized = raw?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const label = normalized.length > 32 ? `${normalized.slice(0, 31)}…` : normalized;
  const classToken = normalized.toLocaleLowerCase().replace(/[^a-z0-9_+.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return classToken ? { label, className: `language-${classToken}` } : { label };
}

class UniqueValueBuilder {
  private counts = new Map<string, number>();

  make(base: string): string {
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 96);
}

function headingPlainText(text: string): string {
  return text
    .replace(/!??\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

export function markdownHeadingSlug(text: string): string {
  const slug = headingPlainText(text)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return slug || "section";
}

export function splitGfmTableRow(line: string): string[] {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  for (const char of source) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line: string): MarkdownAlignment[] | null {
  const cells = splitGfmTableRow(line);
  if (cells.length === 0 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    if (cell.startsWith(":")) return "left";
    return null;
  });
}

export function parseMarkdownDocument(source: string): ParsedMarkdownDocument {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const toc: MarkdownTocEntry[] = [];
  const keys = new UniqueValueBuilder();
  const slugs = new UniqueValueBuilder();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (fence) {
      const marker = fence[1][0];
      const minLength = fence[1].length;
      const language = fence[2]?.trim() || undefined;
      const body: string[] = [];
      index++;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{${minLength},}\\s*$`).test(lines[index])) {
        body.push(lines[index++]);
      }
      if (index < lines.length) index++;
      const text = body.join("\n");
      blocks.push({ type: "code", language, text, key: keys.make(`code-${compact(text) || "empty"}`) });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      const text = heading[2];
      const id = slugs.make(markdownHeadingSlug(text));
      blocks.push({ type: "heading", level, text, id, key: keys.make(`heading-${id}`) });
      toc.push({ level, text: headingPlainText(text), id });
      index++;
      continue;
    }

    if (index + 1 < lines.length && line.includes("|")) {
      const alignments = tableAlignments(lines[index + 1]);
      if (alignments) {
        const header = splitGfmTableRow(line);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
          rows.push(splitGfmTableRow(lines[index++]));
        }
        const width = Math.max(header.length, alignments.length);
        blocks.push({
          type: "table",
          header: Array.from({ length: width }, (_, column) => header[column] ?? ""),
          rows: rows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? "")),
          alignments: Array.from({ length: width }, (_, column) => alignments[column] ?? null),
          key: keys.make(`table-${compact(header.join("|"))}`),
        });
        continue;
      }
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: "rule", key: keys.make("rule") });
      index++;
      continue;
    }
    if (line.startsWith("> ")) {
      const quote = [line.slice(2)];
      index++;
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push({ type: "quote", text: quote.join("\n"), key: keys.make(`quote-${compact(quote.join(" "))}`) });
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items = [line.replace(/^\s*[-*]\s/, "")];
      index++;
      while (index < lines.length && /^\s*[-*]\s/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s/, ""));
      blocks.push({ type: "unordered-list", items, key: keys.make(`ul-${compact(items.join("|"))}`) });
      continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      const items = [line.replace(/^\s*\d+\.\s/, "")];
      index++;
      while (index < lines.length && /^\s*\d+\.\s/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+\.\s/, ""));
      blocks.push({ type: "ordered-list", items, key: keys.make(`ol-${compact(items.join("|"))}`) });
      continue;
    }
    if (line.trim() === "") {
      index++;
      continue;
    }

    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() !== "" && !/^(#{1,3})\s/.test(lines[index]) && !/^\s*(`{3,}|~{3,})/.test(lines[index]) && !lines[index].startsWith("> ") && !/^\s*[-*]\s/.test(lines[index]) && !/^\s*\d+\.\s/.test(lines[index]) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes("|") && tableAlignments(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    const text = paragraph.join(" ");
    blocks.push({ type: "paragraph", text, key: keys.make(`paragraph-${compact(text)}`) });
  }

  return { blocks, toc };
}
