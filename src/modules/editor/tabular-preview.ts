const MAX_ROWS = 200;
const MAX_COLUMNS = 40;
const MAX_CELL_CHARS = 240;

export type TabularKind = "json" | "csv" | "tsv";

export interface TabularPreview {
  kind: TabularKind;
  columns: string[];
  rows: string[][];
  truncated: boolean;
  rowCount: number;
}

export function tabularKindFromName(fileName: string): TabularKind | null {
  if (/\.jsonl?$/i.test(fileName)) return "json";
  if (/\.csv$/i.test(fileName)) return "csv";
  if (/\.tsv$/i.test(fileName)) return "tsv";
  return null;
}

function clipCell(value: string): string {
  return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
}

function asCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return clipCell(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return clipCell(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

function finishTable(kind: TabularKind, columns: string[], rows: string[][], totalRows: number): TabularPreview {
  return {
    kind,
    columns: columns.slice(0, MAX_COLUMNS),
    rows: rows.map((row) => row.slice(0, MAX_COLUMNS)),
    truncated: totalRows > rows.length || columns.length > MAX_COLUMNS,
    rowCount: totalRows,
  };
}

function tableFromObjects(kind: TabularKind, records: Record<string, unknown>[]): TabularPreview {
  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key)) columns.push(key);
      if (columns.length >= MAX_COLUMNS) break;
    }
    if (columns.length >= MAX_COLUMNS) break;
  }
  const rows = records.slice(0, MAX_ROWS).map((record) => columns.map((column) => asCell(record[column])));
  return finishTable(kind, columns.length ? columns : ["value"], rows, records.length);
}

export function parseDelimitedTable(content: string, kind: "csv" | "tsv"): TabularPreview | null {
  const delimiter = kind === "tsv" ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => {
    row.push(clipCell(cell));
    cell = "";
  };
  const pushRow = () => {
    if (row.length === 1 && row[0] === "" && rows.length === 0) {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < content.length; index++) {
    const ch = content[index];
    if (quoted) {
      if (ch === '"') {
        if (content[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      continue;
    }
    if (ch === "\n") {
      pushCell();
      pushRow();
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (quoted) return null;
  if (cell !== "" || row.length > 0) {
    pushCell();
    pushRow();
  }
  if (rows.length === 0) return null;
  const columns = rows[0].map((name, index) => name || `col${index + 1}`);
  const body = rows.slice(1);
  return finishTable(kind, columns, body.slice(0, MAX_ROWS), body.length);
}

export function parseJsonTable(content: string): TabularPreview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const records: Record<string, unknown>[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          records.push(value as Record<string, unknown>);
        } else {
          records.push({ value });
        }
      } catch {
        return null;
      }
      if (records.length > MAX_ROWS) break;
    }
    return records.length > 0 ? tableFromObjects("json", records) : null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return finishTable("json", ["value"], [], 0);
    if (parsed.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      return tableFromObjects("json", parsed as Record<string, unknown>[]);
    }
    const rows = parsed.slice(0, MAX_ROWS).map((item) => [asCell(item)]);
    return finishTable("json", ["value"], rows, parsed.length);
  }
  if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed as Record<string, unknown>);
    const rows = entries.slice(0, MAX_ROWS).map(([key, value]) => [clipCell(key), asCell(value)]);
    return finishTable("json", ["key", "value"], rows, entries.length);
  }
  return finishTable("json", ["value"], [[asCell(parsed)]], 1);
}

export function parseTabularPreview(fileName: string, content: string): TabularPreview | null {
  const kind = tabularKindFromName(fileName);
  if (!kind || content.length === 0) return null;
  return kind === "json" ? parseJsonTable(content) : parseDelimitedTable(content, kind);
}
