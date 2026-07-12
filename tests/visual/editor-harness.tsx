import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { FilePreview } from "@/ui/FilePreview";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { editorDraftKey, retainEditorDraft } from "@/modules/editor/editor-draft-registry";
import "@/styles/globals.css";

const params = new URLSearchParams(window.location.search);
const language = params.get("lang") === "zh" ? "zh" : "en";
const remote = params.get("transport") !== "local";
const scenario = params.get("state");
const requestedWidth = Number(params.get("width"));
const panelWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
  ? Math.min(requestedWidth, 900)
  : "100%";
document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
setLanguage(language);
useSessionsStore.setState({ activeSessionId: "visual-editor-session" });
const filePath = "/tmp/tunara-visual/部署说明与回滚检查清单.md";

const original = {
  kind: "text",
  content: "# Deployment notes\n\nKeep the release small, reversible, and observable.\n\n```sh\npnpm build\n```\n",
  size: 97,
  fingerprint: "a".repeat(64),
} as const;

if (scenario === "conflict") {
  retainEditorDraft(editorDraftKey("visual-editor-session", filePath), {
    content: `${original.content}本地草稿仍需保留。\n`,
    savedContent: original.content,
    fingerprint: original.fingerprint,
    saveState: "conflict",
    unknownOutcome: null,
  });
}

function VisualDiagnostics() {
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const surface = document.querySelector<HTMLElement>(".file-editor-surface");
      const header = document.querySelector<HTMLElement>(".file-editor-header");
      if (!surface || !header) return;
      document.documentElement.dataset.editorWidth = String(Math.round(surface.getBoundingClientRect().width));
      document.documentElement.dataset.headerDisplay = getComputedStyle(header).display;
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return null;
}

mockIPC((command) => {
  if (command === "ssh_fs_read_file" || command === "fs_read_file") return original;
  if (command === "ssh_fs_write_text_file" || command === "fs_write_text_file") {
    return { status: "conflict", currentFingerprint: "b".repeat(64) };
  }
  throw new Error(`Unexpected visual harness command: ${command}`);
});

document.body.style.margin = "0";
document.body.style.width = "100vw";
document.body.style.height = "100vh";
document.body.style.overflow = "hidden";
document.body.style.background = "var(--c-bg-2)";

createRoot(document.getElementById("root")!).render(
  <>
    <VisualDiagnostics />
    <main style={{ width: "100vw", height: "100vh", padding: 12, boxSizing: "border-box", display: "flex", justifyContent: "center" }}>
      <section style={{ width: panelWidth, height: "100%", overflow: "hidden", borderRadius: "var(--r-card)", boxShadow: "var(--shadow-card)" }}>
        <FilePreview
          filePath={filePath}
          fileName="部署说明与回滚检查清单.md"
          fill
          remotePtyId={remote ? 41 : undefined}
          onClose={() => {}}
        />
      </section>
    </main>
  </>,
);
