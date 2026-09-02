import React from "react";
import { createRoot } from "react-dom/client";
import { NotebookPreview, TabularTable } from "@/ui/FilePreview";
import { FileIcon, FolderIcon } from "@/ui/file-explorer/icons";
import { FILE_KIND_FAMILIES, fileKindTint } from "@/ui/file-explorer/file-kind";
import { setLanguage } from "@/modules/i18n";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/files.css";

setLanguage("en");
document.documentElement.lang = "en";

const samples: Record<(typeof FILE_KIND_FAMILIES)[number], string> = {
  code: "index.ts",
  data: "users.csv",
  doc: "README.md",
  image: "photo.png",
  config: ".env",
  script: "setup.py",
  log: "server.log",
};

const table = {
  kind: "csv" as const,
  columns: ["name", "count", "note"],
  rows: [
    ["alpha", "12", "ok"],
    ["beta", "3.5", "queued"],
    ["gamma", "100", "done"],
  ],
  truncated: false,
  rowCount: 3,
};

const notebook = JSON.stringify({
  nbformat: 4,
  metadata: { language_info: { name: "python" } },
  cells: [
    { cell_type: "markdown", source: "# Notebook heading\n\nRead-only markdown cell." },
    {
      cell_type: "code",
      execution_count: 4,
      source: "print('safe')",
      outputs: [
        { output_type: "stream", text: "safe output\n" },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["ValueError: bad"] },
        { output_type: "display_data", data: { "image/png": "abc" } },
      ],
    },
  ],
});

function App() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--c-bg-1)", color: "var(--c-text-primary)", fontFamily: "var(--font-ui)" }}>
      <div style={{ padding: 16, display: "grid", gap: 18, maxWidth: 960, margin: "0 auto" }}>
        <section>
          <h1 style={{ fontSize: 16, margin: "0 0 10px" }}>File family icons</h1>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><FolderIcon /> folder</span>
            {FILE_KIND_FAMILIES.map((family) => (
              <span key={family} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <FileIcon tint={fileKindTint(samples[family])} />
                <span>{samples[family]}</span>
              </span>
            ))}
          </div>
        </section>
        <section style={{ background: "var(--c-bg-white)", minHeight: 180, display: "flex" }}>
          <div className="preview-message">
            <span className="preview-message-icon" aria-hidden="true">⊘</span>
            <span className="preview-message-text">Binary file · 12 KB</span>
          </div>
        </section>
        <section style={{ background: "var(--c-bg-white)", maxHeight: 240, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <TabularTable table={table} />
        </section>
        <section style={{ background: "var(--c-bg-white)", minHeight: 420 }}>
          <NotebookPreview content={notebook} />
        </section>
        <section className="image-preview" style={{ minHeight: 220 }}>
          <div className="image-preview-surface" aria-label="Transparent image checkerboard">
            <div style={{ width: 96, height: 64, background: "linear-gradient(90deg, transparent, var(--c-file-image))", border: "1px solid var(--c-border-2)" }} />
          </div>
          <p className="image-preview-caption">96 × 64 · 4 KB</p>
        </section>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
