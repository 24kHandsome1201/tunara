import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { NotebookPreview, TabularTable } from "@/ui/FilePreview";
import { FileIcon } from "@/ui/file-explorer/icons";
import { fileKindTint } from "@/ui/file-explorer/file-kind";
import type { TabularPreview } from "@/modules/editor/tabular-preview";

describe("file preview surface tints", () => {
  test("TabularTable tints the shell, zebras rows, and right-aligns numeric columns", () => {
    const table: TabularPreview = {
      kind: "csv",
      columns: ["name", "count"],
      rows: [
        ["alpha", "1"],
        ["beta", "2"],
        ["gamma", "3"],
      ],
      truncated: false,
      rowCount: 3,
      columnCount: 2,
    };

    const { container } = render(<TabularTable table={table} />);
    expect(container.querySelector(".tabular-preview")).toBeTruthy();
    expect(container.querySelector(".tabular-table")).toBeTruthy();
    expect(screen.getByText("Read-only CSV table")).toBeTruthy();

    const headers = [...container.querySelectorAll("thead th")];
    expect(headers[0].className).toBe("");
    expect(headers[1].className).toContain("tabular-cell--numeric");

    const firstRow = [...container.querySelectorAll("tbody tr")[0].querySelectorAll("td")];
    expect(firstRow[0].className).toBe("");
    expect(firstRow[1].className).toContain("tabular-cell--numeric");
    expect(firstRow[1].textContent).toBe("1");
  });

  test.each([
    [300, 2, "Read-only JSON table · Showing 200 of 300 rows"],
    [200, 55, "Read-only JSON table · Showing 40 of 55 columns"],
    [300, 55, "Read-only JSON table · Showing 200 of 300 rows · Showing 40 of 55 columns"],
    [200, 2, "Read-only JSON table"],
    [0, 2, "Read-only JSON table"],
  ])("caption reports hidden dimensions (%i rows, %i columns)", (rowCount, columnCount, caption) => {
    const table: TabularPreview = {
      kind: "json",
      columns: Array.from({ length: Math.min(columnCount, 40) }, (_, i) => `key${i}`),
      rows: Array.from({ length: Math.min(rowCount, 200) }, () => []),
      rowCount,
      columnCount,
      truncated: rowCount > 200 || columnCount > 40,
    };
    const { container } = render(<TabularTable table={table} />);
    expect(container.querySelector("caption")?.textContent).toBe(caption);
  });

  test("NotebookPreview distinguishes markdown, code, and error cells", () => {
    const notebook = JSON.stringify({
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: "# Heading" },
        {
          cell_type: "code",
          execution_count: 7,
          source: "print('ok')",
          outputs: [
            { output_type: "stream", text: "ok\n" },
            { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["ValueError: bad"] },
            { output_type: "display_data", data: { "image/png": "abc" } },
          ],
        },
      ],
    });

    const { container } = render(<NotebookPreview content={notebook} />);
    const markdown = container.querySelector('[data-cell-kind="markdown"]');
    const code = container.querySelector('[data-cell-kind="code"]');
    expect(markdown).toBeTruthy();
    expect(code).toBeTruthy();
    expect(markdown?.querySelector(".notebook-cell-gutter")?.textContent).toBe("Md");
    expect(code?.querySelector(".notebook-cell-gutter")?.textContent).toBe("In [7]");
    expect(container.querySelector(".notebook-output-error")).toBeTruthy();
    expect(container.querySelector(".notebook-output-omitted")).toBeTruthy();
    expect(screen.getByText("Rich output omitted for safety")).toBeTruthy();
  });

  test("FileIcon applies the family tint to currentColor without coloring the name", () => {
    const { container } = render(<FileIcon tint={fileKindTint("index.ts")} />);
    const svg = container.querySelector("svg");
    // Phosphor glyphs are filled paths; the tint is applied as the svg fill.
    expect(svg?.classList.contains("file-icon")).toBe(true);
    expect(svg?.getAttribute("fill")).toBe("var(--c-file-code)");
    expect(container.textContent).toBe("");
  });
});
