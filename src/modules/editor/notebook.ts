export type NotebookOutput =
  | { kind: "text"; text: string }
  | { kind: "error"; name: string; value: string; traceback: string[] }
  | { kind: "omitted" };

export type NotebookCell =
  | { kind: "markdown"; source: string }
  | { kind: "code"; source: string; executionCount: number | null; outputs: NotebookOutput[] }
  | { kind: "raw"; source: string };

export type NotebookDocument = {
  nbformat: number;
  language: string | null;
  cells: NotebookCell[];
};

export type NotebookParseResult =
  | { ok: true; notebook: NotebookDocument }
  | { ok: false; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join("");
  }
  return "";
}

function parseOutput(value: unknown): NotebookOutput | null {
  const output = record(value);
  if (!output || typeof output.output_type !== "string") return null;
  if (output.output_type === "stream") {
    return { kind: "text", text: sourceText(output.text) };
  }
  if (output.output_type === "error") {
    return {
      kind: "error",
      name: typeof output.ename === "string" ? output.ename : "Error",
      value: typeof output.evalue === "string" ? output.evalue : "",
      traceback: Array.isArray(output.traceback)
        ? output.traceback.filter((line): line is string => typeof line === "string")
        : [],
    };
  }
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const data = record(output.data);
    const plain = sourceText(data?.["text/plain"]);
    return plain ? { kind: "text", text: plain } : { kind: "omitted" };
  }
  return null;
}

function parseCell(value: unknown): NotebookCell | null {
  const cell = record(value);
  if (!cell || typeof cell.cell_type !== "string") return null;
  const source = sourceText(cell.source);
  if (cell.cell_type === "markdown") return { kind: "markdown", source };
  if (cell.cell_type === "raw") return { kind: "raw", source };
  if (cell.cell_type !== "code") return null;
  const executionCount = typeof cell.execution_count === "number" && Number.isFinite(cell.execution_count)
    ? cell.execution_count
    : null;
  return {
    kind: "code",
    source,
    executionCount,
    outputs: Array.isArray(cell.outputs)
      ? cell.outputs.map(parseOutput).filter((output): output is NotebookOutput => output !== null)
      : [],
  };
}

export function parseNotebook(content: string): NotebookParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const root = record(parsed);
  if (!root || !Array.isArray(root.cells) || typeof root.nbformat !== "number") {
    return { ok: false, message: "Missing notebook cells or nbformat" };
  }
  const metadata = record(root.metadata);
  const kernelspec = record(metadata?.kernelspec);
  const languageInfo = record(metadata?.language_info);
  const language = typeof kernelspec?.display_name === "string"
    ? kernelspec.display_name
    : typeof languageInfo?.name === "string"
      ? languageInfo.name
      : null;
  return {
    ok: true,
    notebook: {
      nbformat: root.nbformat,
      language,
      cells: root.cells.map(parseCell).filter((cell): cell is NotebookCell => cell !== null),
    },
  };
}
