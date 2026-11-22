export type MarkdownAlignment = "left" | "center" | "right" | null;
export type MdxSourceKind = "module" | "component" | "expression";

export type MarkdownList = (
  | { type: "unordered-list" }
  | { type: "ordered-list"; start: number }
) & { items: string[]; children?: Record<number, MarkdownList[]>; key: string };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; id: string; key: string }
  | { type: "paragraph"; text: string; key: string }
  | { type: "code"; language?: string; text: string; key: string }
  | { type: "quote"; text: string; key: string }
  | MarkdownList
  | { type: "table"; header: string[]; rows: string[][]; alignments: MarkdownAlignment[]; key: string }
  | { type: "mdx-source"; kind: MdxSourceKind; text: string; key: string }
  | { type: "rule"; key: string };

export interface MarkdownTocEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
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
  private used = new Set<string>();
  private nextSuffix = new Map<string, number>();

  make(base: string): string {
    let suffix = this.nextSuffix.get(base) ?? 1;
    let value = suffix === 1 ? base : `${base}-${suffix}`;
    while (this.used.has(value)) value = `${base}-${++suffix}`;
    this.nextSuffix.set(base, suffix + 1);
    this.used.add(value);
    return value;
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

export function mdxSourceKind(line: string): MdxSourceKind | null {
  const trimmed = line.trim();
  if (/^import\s+(?:[\w*{]|["'])/.test(trimmed)) return "module";
  if (/^export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|type\b|interface\b|\{)/.test(trimmed)) return "module";
  if (/^<\/?[A-Za-z][A-Za-z0-9_.:-]*(?:\s|\/?>|$)/.test(trimmed)) return "component";
  if (/^\{/.test(trimmed)) return "expression";
  return null;
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

const QUOTE_MARKER = /^>[ \t]?/;
const LIST_ITEM = /^([ \t]*)([-*]|\d+\.)(\s+)([\s\S]*)$/;

export function parseMarkdownDocument(source: string, options?: { mdx?: boolean }): ParsedMarkdownDocument {
  // Plain .md files often contain inline HTML (e.g. `<p align="center">`);
  // MDX constructs are only recognized when the caller marks the source .mdx.
  const mdx = options?.mdx === true;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const toc: MarkdownTocEntry[] = [];
  const keys = new UniqueValueBuilder();
  const slugs = new UniqueValueBuilder();
  let index = 0;

  function readList(first: RegExpMatchArray): MarkdownList {
    const indent = first[1].replace(/\t/g, "    ").length;
    const ordered = first[2].endsWith(".");
    const number = Number.parseInt(first[2], 10);
    const list: MarkdownList = {
      ...(ordered ? { type: "ordered-list", start: Number.isSafeInteger(number) ? number : 1 } as const : { type: "unordered-list" } as const),
      items: [], key: keys.make(`${ordered ? "ol" : "ul"}-${compact(first[4])}`),
    };
    let contentColumn = indent;
    while (index < lines.length) {
      const match = lines[index].match(LIST_ITEM);
      if (!match) break;
      const depth = match[1].replace(/\t/g, "    ").length;
      if (depth < indent) break;
      if (list.items.length > 0 && depth >= contentColumn) {
        const children = list.children ??= {};
        (children[list.items.length - 1] ??= []).push(readList(match));
      } else {
        if (match[2].endsWith(".") !== ordered) break;
        list.items.push(match[4]);
        contentColumn = depth + match[2].length + match[3].replace(/\t/g, "    ").length;
        index++;
      }
    }
    return list;
  }

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

    const mdxKind = mdx ? mdxSourceKind(line) : null;
    if (mdxKind) {
      const sourceLines = [line];
      index++;
      while (index < lines.length && lines[index].trim() !== "" && !mdxSourceKind(lines[index])) {
        sourceLines.push(lines[index++]);
      }
      const text = sourceLines.join("\n");
      blocks.push({ type: "mdx-source", kind: mdxKind, text, key: keys.make(`mdx-${mdxKind}-${compact(text)}`) });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length as MarkdownTocEntry["level"];
      const text = heading[2].replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trimEnd();
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
    if (QUOTE_MARKER.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && QUOTE_MARKER.test(lines[index])) quote.push(lines[index++].replace(QUOTE_MARKER, ""));
      blocks.push({ type: "quote", text: quote.join("\n"), key: keys.make(`quote-${compact(quote.join(" "))}`) });
      continue;
    }
    const listItem = line.match(LIST_ITEM);
    if (listItem) {
      blocks.push(readList(listItem));
      continue;
    }
    if (line.trim() === "") {
      index++;
      continue;
    }

    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() !== "" && !(mdx && mdxSourceKind(lines[index])) && !/^(#{1,6})\s/.test(lines[index]) && !/^\s*(`{3,}|~{3,})/.test(lines[index]) && !QUOTE_MARKER.test(lines[index]) && !/^\s*[-*]\s/.test(lines[index]) && !/^\s*\d+\.\s/.test(lines[index]) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes("|") && tableAlignments(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    const text = paragraph.join(" ");
    blocks.push({ type: "paragraph", text, key: keys.make(`paragraph-${compact(text)}`) });
  }

  return { blocks, toc };
}
