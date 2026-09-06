import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { setLanguage } from "@/modules/i18n";
import { useTheme } from "@/app/useTheme";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { Sidebar } from "@/ui/Sidebar";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { ReaderPane } from "@/ui/ReaderPane";
import { WorkspaceEmptyState } from "@/ui/WorkspaceEmptyState";
import { Settings } from "@/ui/overlays/Settings";
import type { Session } from "@/ui/types";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@/styles/files.css";

// Production components with deterministic, explicitly mocked desktop I/O.
// This is a component preview, not a working shell or SSH connection.
const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "workspace";
const lang = params.get("lang") === "en" ? "en" : "zh-CN";
setLanguage(lang);
const remote = mode === "transfers";
const session: Session = {
  id: "preview-session", title: "Terminal 1", customTitle: "Tunara", dir: "/work/tunara",
  agent: "CC", agentActivity: "waiting_confirmation", runState: "idle", updatedAt: 1,
  branch: "main", gitState: "repo", reviewChangesHint: true,
  changes: { files: [{ path: "src/app.ts", stage: "unstaged", status: "M", added: 3, removed: 1 }] },
  ...(remote ? { remote: { user: "deploy", host: "example.test", port: 22 }, ptyId: 42,
    transportGeneration: "preview-generation", connection: { transport: "ssh" as const, phase: "ready" as const, source: "backend" as const, updatedAt: 1 } } : {}),
};
useSessionsStore.setState({ sessions: mode === "empty" ? [] : [session, { ...session, id: "preview-two", customTitle: undefined, title: "Terminal 2", agentActivity: "running" }], activeSessionId: session.id, recentDirs: ["/work/tunara", "/work/website"] });
useUIStore.setState({ theme: params.get("theme") === "dark" ? "dark" : "light", language: lang, inspectorTab: mode === "transfers" ? "transfers" : "files", overlay: mode === "settings" ? "settings" : null, configLoaded: false });
if (remote) useTransferStore.getState().replaceItemsForTest([{
  transferId: "preview-transfer", binding: { logicalSessionId: session.id, physicalPtyId: 42, transportGeneration: "preview-generation" },
  source: "/srv/app/server.log", destination: "/Downloads/server.log", direction: "download", conflict: "rename",
  attempt: 1, status: "failed", cancelRequested: false, error: "Permission denied",
}]);

mockIPC((command) => {
  if (command === "plugin:app|version") return "3.0.2";
  if (command === "plugin:os|platform") return "linux";
  if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
  if (["resolve_all_bins", "ssh_hosts_load", "ssh_known_hosts_list", "fs_scan_recent_repos", "fs_read_dir", "ssh_fs_read_dir"].includes(command)) return [];
  if (command === "git_ahead_behind") return { state: "noUpstream", branch: "main" };
  if (command === "git_diff") return { kind: "text", path: "src/app.ts", patch: "@@ -1,2 +1,4 @@\n-export const title = 'Working';\n+export const title = 'Tunara';\n+export const quiet = true;\n+export const readable = true;\n", truncated: false, totalLines: 5 };
  if (command === "ssh_fs_home") return "/home/deploy";
  if (command === "fs_cancel_search") return true;
  return undefined;
});

function Preview() {
  useTheme();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const active = sessions.find((s) => s.id === activeId) ?? session;
  const reader = useUIStore((s) => s.readers[active.id]?.current);
  const overlay = useUIStore((s) => s.overlay);
  const newTerminal = () => useSessionsStore.getState().newTerminalInDir("/work/tunara");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="tunara-titlebar" style={{ minHeight: 38, padding: "8px 14px", borderBottom: "1px solid var(--c-border-1)", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span>Tunara · Component preview · Mock desktop I/O</span>
        <button onClick={() => useUIStore.getState().openSettings()} style={{ background: "transparent", border: 0, color: "var(--c-text-primary)", cursor: "pointer" }}>{lang === "en" ? "Settings" : "设置"}</button>
      </header>
      {mode === "empty" && sessions.length === 0 ? <WorkspaceEmptyState onNewTerminal={newTerminal} onNewTerminalInDirectory={newTerminal} onOpenSsh={() => useUIStore.getState().openSshConnect()} /> : (
        <main style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <aside className="tunara-sidebar" style={{ width: 250, flexShrink: 0 }}><Sidebar sessions={sessions} activeSessionId={active.id} onSelectSession={(id) => useSessionsStore.getState().setActive(id)} onNewTerminal={newTerminal} onNewTerminalInDirectory={newTerminal} /></aside>
          <section style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", padding: 18, fontFamily: "var(--font-mono)", color: "var(--c-text-3)", background: "var(--terminal-canvas-bg)" }}>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{"$ claude\n\nChanges are ready for review.\n\nThis preview does not run commands."}</pre>
            <textarea aria-label="Terminal focus target" className="xterm" style={{ resize: "none", color: "var(--c-text-primary)", background: "transparent", border: "none", outline: "none" }} defaultValue="$ " />
          </section>
          {reader && <section style={{ flex: 1, minWidth: 240, display: "flex" }}><ReaderPane session={active} active /></section>}
          <aside className="tunara-panel" style={{ width: Number(params.get("width") ?? 320), display: "flex", flexShrink: 0 }}><InspectorPanel session={active} /></aside>
        </main>
      )}
      {overlay === "settings" && <Settings onClose={() => useUIStore.getState().setOverlay(null)} />}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
