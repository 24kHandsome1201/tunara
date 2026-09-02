import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { FileExplorer } from "@/ui/FileExplorer";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import type { DirEntry } from "@/modules/fs/fs-bridge";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/files.css";

const ROOT = "/opt/wfs/repo";
const params = new URLSearchParams(window.location.search);
const language = params.get("lang") === "en" ? "en" : "zh-CN";
const expand = params.get("expand") !== "0";
const scenario = params.get("scenario") ?? "local";
const requestedWidth = Number(params.get("width") ?? "320");
const panelWidth = Number.isFinite(requestedWidth) ? Math.max(220, Math.min(560, requestedWidth)) : 320;
const isRemote = scenario.startsWith("remote") || scenario === "upload-folder";
document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";
setLanguage(language);
useSessionsStore.setState({
  activeSessionId: isRemote ? "remote" : "local",
  hostFilePrefs: {},
  sessions: isRemote ? [{
    id: "remote",
    title: "deploy@example",
    dir: "/srv/app",
    branch: "",
    runState: "idle",
    updatedAt: 1,
    remote: { host: "example", port: 22, user: "deploy", authMethod: "agent" },
    ptyId: 40,
    transportGeneration: "visual-generation",
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  }] : [{ id: "local", title: "Local", dir: ROOT, branch: "", runState: "idle", updatedAt: 1 }],
});
useUIStore.setState({ inspectorTab: "files", panelWidth, language });

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
  "/srv/app": [
    entry("src", "dir", now - 36e5),
    entry("infrastructure", "dir", now - 864e5),
    entry("README-production.md", "file", now - 1728e5, 8_200),
    entry("service.env.example", "file", now - 72e5, 1_400),
  ],
  "/srv/app/src": [entry("server.ts", "file", now - 18e5, 4_200)],
};

if (scenario === "upload-folder") {
  useTransferStore.getState().replaceItemsForTest([{
    transferId: "visual-folder-upload",
    batchId: "visual-folder-batch",
    binding: { logicalSessionId: "remote", physicalPtyId: 40, transportGeneration: "visual-generation" },
    direction: "upload",
    source: "/home/alice/project/src/server.ts",
    destination: "/srv/app/project/src/server.ts",
    conflict: "rename",
    attempt: 1,
    status: "running",
    cancelRequested: false,
    event: { transferId: "visual-folder-upload", attempt: 1, sequence: 1, phase: "transferring", bytesTransferred: 42, totalBytes: 100 },
  }]);
} else {
  useTransferStore.getState().replaceItemsForTest([]);
}

mockIPC((command, payload) => {
  if (command === "ssh_fs_home") return "/home/deploy";
  if (command === "ssh_fs_read_dir") {
    if (scenario === "remote-error") throw new Error("Permission denied");
    if (scenario === "remote-empty") return [];
    const path = (payload as { path: string }).path;
    return listing[path] ?? [];
  }
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
    if (isRemote) return;
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

function VisualRemoteReady({ disconnect }: { disconnect: () => void }) {
  React.useEffect(() => {
    if (!isRemote) return;
    let cancelled = false;
    const ready = async () => {
      for (let attempt = 0; attempt < 100 && !cancelled; attempt += 1) {
        if (scenario === "remote-disconnected") {
          if (document.body.textContent?.includes(language === "zh-CN" ? "远程文件暂不可用" : "Remote files are unavailable")) break;
        } else if (scenario === "remote-empty") {
          if (document.body.textContent?.includes(language === "zh-CN" ? "目录为空" : "Directory is empty")) break;
        } else if (scenario === "remote-error") {
          if (document.querySelector('[role="alert"]')) break;
        } else if (document.querySelector('[role="treeitem"]')) {
          if (scenario === "remote-cached") {
            disconnect();
            await new Promise((resolve) => window.setTimeout(resolve, 50));
          }
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      if (!cancelled) document.documentElement.dataset.explorerReady = scenario;
    };
    void ready();
    return () => { cancelled = true; };
  }, [disconnect]);
  return null;
}

function ExplorerFixture() {
  const initiallyConnected = scenario !== "remote-disconnected";
  const [connected, setConnected] = React.useState(initiallyConnected);
  const disconnect = React.useCallback(() => setConnected(false), []);
  return (
    <>
      <VisualRemoteReady disconnect={disconnect} />
      <FileExplorer
        sessionId={isRemote ? "remote" : "local"}
        rootDir={isRemote ? "/srv/app" : ROOT}
        remote={isRemote}
        remotePtyId={isRemote && connected ? 40 : undefined}
        transportGeneration={isRemote && connected ? "visual-generation" : undefined}
        remoteHost={isRemote ? "deploy@example" : undefined}
      />
    </>
  );
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
          width: panelWidth,
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
          {language === "zh-CN" ? "文件" : "Files"} · {panelWidth}px
        </div>
        <ExplorerFixture />
      </section>
    </main>
  </>,
);
