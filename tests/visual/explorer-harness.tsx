import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { FileExplorer } from "@/ui/FileExplorer";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { DirEntry } from "@/modules/fs/fs-bridge";
import "@/styles/tokens.css";
import "@/styles/globals.css";

const ROOT = "/opt/wfs/repo";
const params = new URLSearchParams(window.location.search);
const language = params.get("lang") === "en" ? "en" : "zh-CN";
const expand = params.get("expand") !== "0";
document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";
setLanguage(language);
useSessionsStore.setState({ activeSessionId: "local" });
useUIStore.setState({ inspectorTab: "files", panelWidth: 320, language });

function entry(name: string, kind: DirEntry["kind"], mtime: number, size = 1): DirEntry {
  return { name, kind, size: kind === "dir" ? 0 : size, mtime };
}

const now = Date.now();
const listing: Record<string, DirEntry[]> = {
  [ROOT]: [
    entry("src", "dir", now - 36e5),
    entry("lib", "dir", now - 864e5),
    entry("README.md", "file", now - 1728e5),
  ],
  [`${ROOT}/src`]: [
    entry("nested", "dir", now - 18e5),
    entry("index.ts", "file", now - 72e5),
  ],
  [`${ROOT}/src/nested`]: [entry("deep.ts", "file", now - 9e5)],
  [`${ROOT}/lib`]: [entry("util.ts", "file", now - 48e5)],
};

mockIPC((command, payload) => {
  if (command === "fs_read_dir") {
    const path = (payload as { path: string }).path;
    return listing[path] ?? [];
  }
  if (command === "fs_cancel_search" || command === "fs_search" || command === "fs_cancel_grep") {
    return command === "fs_search" ? [] : true;
  }
  throw new Error(`Unexpected visual harness command: ${command}`);
});

function rowOf(item: Element) {
  return item.querySelector(":scope > .hover-bg") ?? item;
}

function VisualExpand() {
  React.useEffect(() => {
    if (!expand) {
      document.documentElement.dataset.explorerReady = "collapsed";
      return;
    }
    let cancelled = false;
    const waitFor = async (name: RegExp) => {
      for (let attempt = 0; attempt < 80 && !cancelled; attempt += 1) {
        const match = [...document.querySelectorAll('[role="treeitem"]')]
          .find((node) => name.test(node.getAttribute("aria-label") ?? ""));
        if (match) return match;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      throw new Error(`missing treeitem ${name}`);
    };
    void (async () => {
      const src = await waitFor(/^src$/);
      rowOf(src).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      const nested = await waitFor(/^nested$/);
      rowOf(nested).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      const deep = await waitFor(/^deep\.ts$/);
      if (deep.getAttribute("aria-level") !== "3" || nested.getAttribute("aria-expanded") !== "true") {
        throw new Error("nested tree did not expand in place");
      }
      document.documentElement.dataset.explorerReady = "expanded";
    })().catch((error) => {
      document.documentElement.dataset.explorerReady = "error";
      document.documentElement.dataset.explorerError = String(error);
    });
    return () => { cancelled = true; };
  }, []);
  return null;
}

document.body.style.margin = "0";
document.body.style.width = "100vw";
document.body.style.height = "100vh";
document.body.style.overflow = "hidden";
document.body.style.background = "var(--c-bg-2)";

createRoot(document.getElementById("root")!).render(
  <>
    <VisualExpand />
    <main style={{ width: "100vw", height: "100vh", padding: 16, boxSizing: "border-box", display: "flex", justifyContent: "center" }}>
      <section
        aria-label="Files inspector"
        style={{
          width: 320,
          height: "100%",
          overflow: "hidden",
          borderRadius: "var(--r-card)",
          boxShadow: "var(--shadow-card)",
          background: "var(--c-bg-1)",
          border: "1px solid var(--c-border-1)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{
          minHeight: "var(--h-titlebar)",
          borderBottom: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          fontSize: "var(--fs-secondary)",
          fontWeight: 600,
          color: "var(--c-text-primary)",
        }}>
          {language === "zh-CN" ? "文件" : "Files"}
        </div>
        <FileExplorer sessionId="local" rootDir={ROOT} />
      </section>
    </main>
  </>,
);
