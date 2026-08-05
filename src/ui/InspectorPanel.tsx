import { useEffect, useState, type ReactNode, type KeyboardEvent } from "react";
import { type Session } from "./types";
import { DiffPanel } from "./DiffPanel";
import { FileExplorer } from "./FileExplorer";
import { SessionOverviewPanel } from "./SessionOverviewPanel";
import { SessionNotesPanel } from "./SessionNotesPanel";
import { PreviewPanel } from "./PreviewPanel";
import { useUIStore } from "@/state/ui";
import type { InspectorTab } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { CloseIcon } from "./shared";
import { WorkspaceSourceChip } from "./WorkspaceSource";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "./lib/tab-list-navigation";
import { TransferCenter } from "./TransferCenter";
import { RemoteMetadataPanel } from "@/modules/ssh/remote-fs/RemoteMetadataPanel";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { DiagnosticsCenter } from "@/modules/ssh/DiagnosticsCenter";
import { diagnosticsCenter } from "@/modules/ssh/diagnostics-store";
import { listKnownHostsV1, refreshKnownHostsV1, removeKnownHostV1, type KnownHostsSnapshotV1 } from "@/modules/ssh/known-hosts-bridge";
import { ForwardingPanel } from "@/modules/ssh/ForwardingPanel";
import { copyText } from "./lib/clipboard";
import { INSPECTOR_TAB_DESCRIPTORS, resolveInspectorScope } from "./inspector-scope";

const INSPECTOR_TAB_IDS: readonly InspectorTab[] = ["overview", "changes", "files", "transfers", "metadata", "forwarding", "diagnostics", "knownHosts", "preview", "notes"];
const INSPECTOR_TABPANEL_ID = "inspector-tabpanel";

interface InspectorPanelProps {
  session: Session;
  onClose?: () => void;
  filesOnly?: boolean;
}

function TabButton({ active, onClick, children, tabId }: { active: boolean; onClick: () => void; children: ReactNode; tabId: InspectorTab }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={INSPECTOR_TABPANEL_ID}
      data-tab-id={tabId}
      tabIndex={active ? 0 : -1}
      data-active={active ? "true" : "false"}
      style={{
        height: 36,
        padding: "0 9px",
        borderRadius: 0,
        border: "none",
        borderBottom: active ? "2px solid var(--c-accent)" : "2px solid transparent",
        background: "transparent",
        cursor: "pointer",
        fontSize: "var(--fs-secondary)",
        fontWeight: active ? 600 : 500,
        flexShrink: 0,
        whiteSpace: "nowrap",
        color: active ? "var(--c-text-primary)" : "var(--c-text-5)",
        transition: "border-color var(--duration-fast) var(--ease-smooth), color var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
      }}
      className={active ? "inspector-tab" : "inspector-tab hover-text-3"}
    >
      {children}
    </button>
  );
}

function KnownHostsPanel() {
  const t = useT();
  const [snapshot, setSnapshot] = useState<KnownHostsSnapshotV1 | null>(null);
  const [error, setError] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const load = (refresh = false) => {
    setError(false);
    void (refresh ? refreshKnownHostsV1() : listKnownHostsV1())
      .then(setSnapshot)
      .catch(() => setError(true));
  };
  useEffect(() => {
    void listKnownHostsV1().then(setSnapshot).catch(() => setError(true));
  }, []);
  return (
    <section aria-labelledby="known-hosts-title" style={{ padding: 12, overflow: "auto" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 id="known-hosts-title">{t("known_hosts.title")}</h2>
        <button type="button" onClick={() => load(true)}>{t("known_hosts.refresh")}</button>
      </header>
      {!snapshot && !error && <div role="status">{t("known_hosts.loading")}</div>}
      {error && <div role="alert">{t("known_hosts.failed")}</div>}
      {snapshot?.entries.length === 0 && <p>{t("known_hosts.empty")}</p>}
      <ul>
        {snapshot?.entries.map((entry) => (
          <li key={entry.entryId} style={{ marginBottom: 12 }}>
            <div><strong>{entry.patternDisplay}</strong> · {entry.keyType}</div>
            <code>{entry.fingerprint}</code>
            <button
              type="button"
              disabled={!entry.manageable}
              aria-label={pendingRemove === entry.entryId
                ? t("known_hosts.confirm_remove_item", { host: entry.patternDisplay })
                : t("known_hosts.remove_item", { host: entry.patternDisplay })}
              onClick={() => {
                if (pendingRemove !== entry.entryId) { setPendingRemove(entry.entryId); return; }
                setPendingRemove(null);
                void removeKnownHostV1(snapshot.revision, entry.entryId)
                  .then(setSnapshot)
                  .catch(() => setError(true));
              }}
            >
              {pendingRemove === entry.entryId ? t("known_hosts.confirm_remove") : t("known_hosts.remove")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function InspectorPanel({ session, onClose, filesOnly = false }: InspectorPanelProps) {
  const t = useT();
  const storeTab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);
  const isRemote = !!session.remote;
  const binding: SessionBindingV1 | null = isRemote && session.ptyId !== undefined && session.transportGeneration
    ? { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration }
    : null;
  const forwardingBinding = session.connection?.phase === "ready" ? binding : null;
  const [metadataPath, setMetadataPath] = useState(session.dir);
  const tabIds: readonly InspectorTab[] = filesOnly
    ? ["files"]
    : INSPECTOR_TAB_IDS.filter((id) => (id !== "metadata" || binding !== null) && (id !== "forwarding" || isRemote));
  const tab = filesOnly ? "files" : tabIds.includes(storeTab) ? storeTab : "overview";
  const descriptor = INSPECTOR_TAB_DESCRIPTORS[tab];
  const inspectorScope = resolveInspectorScope(descriptor, session, binding);
  const scopeKey = inspectorScope.kind.replace("-", "_");
  const scopeDescriptionKey = inspectorScope.kind === descriptor.scope
    ? descriptor.descriptionKey
    : `inspector.scope.description.${scopeKey}`;
  const showSourceSummary = Boolean(
    currentWorkspaceWorktree(session.workspace)
    || session.workspaceState === "unavailable"
    || (tab === "changes" && !session.workspace && session.branch),
  );
  let activePanel: ReactNode;
  switch (tab) {
    case "changes":
      activePanel = <DiffPanel session={session} embedded />;
      break;
    case "files":
      activePanel = <FileExplorer
        sessionId={session.id}
        rootDir={session.dir}
        remotePtyId={isRemote ? session.ptyId : undefined}
        transportGeneration={session.transportGeneration}
        remote={isRemote}
        remoteHost={session.remote ? `${session.remote.user}@${session.remote.host}` : undefined}
        onInspectRemotePath={(path) => { setMetadataPath(path); setTab("metadata"); }}
      />;
      break;
    case "transfers":
      activePanel = <TransferCenter inspectorScope={inspectorScope} />;
      break;
    case "metadata":
      activePanel = binding
        ? <RemoteMetadataPanel binding={binding} path={metadataPath} host={`${session.remote!.user}@${session.remote!.host}`} />
        : <SessionOverviewPanel session={session} />;
      break;
    case "forwarding":
      activePanel = <ForwardingPanel
        key={`${session.id}:${forwardingBinding?.physicalPtyId ?? "offline"}:${forwardingBinding?.transportGeneration ?? "none"}`}
        binding={forwardingBinding}
        session={session}
      />;
      break;
    case "diagnostics":
      activePanel = <DiagnosticsCenter
        sessionId={session.id}
        onClose={() => setTab("overview")}
        onCopyReport={async (report) => {
          const copied = await copyText(report);
          useUIStore.getState().addToast({
            sessionId: session.id,
            title: t(copied ? "diagnostics.copy_succeeded" : "diagnostics.copy_failed"),
            subtitle: "",
            variant: copied ? "success" : "error",
          });
        }}
      />;
      break;
    case "knownHosts":
      activePanel = <KnownHostsPanel />;
      break;
    case "preview":
      activePanel = <PreviewPanel session={session} />;
      break;
    case "notes":
      activePanel = <SessionNotesPanel session={session} />;
      break;
    case "overview":
      activePanel = <SessionOverviewPanel session={session} />;
      break;
  }

  const handleTabListKeyDown = (e: KeyboardEvent) => {
    const currentId = tabIdFromEventTarget(e.target);
    if (!currentId) return;
    const nextId = resolveRovingTabId(tabIds, currentId, e.key);
    if (!nextId || nextId === currentId) return;
    e.preventDefault();
    setTab(nextId as InspectorTab);
    focusTabById(e.currentTarget as HTMLElement, nextId);
  };

  return (
    <div style={{ width: "100%", background: "var(--c-bg-2)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ minHeight: "var(--h-titlebar)", background: "var(--c-bg-1)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", paddingLeft: 8, gap: 0, flexShrink: 0 }}>
        <div
          className="no-scrollbar"
          role="tablist"
          aria-label={t("inspector.tab.aria_label")}
          onKeyDown={handleTabListKeyDown}
          style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}
        >
          {!filesOnly && <TabButton tabId="overview" active={tab === "overview"} onClick={() => setTab("overview")}>{t("inspector.tab.overview")}</TabButton>}
          {!filesOnly && <TabButton tabId="changes" active={tab === "changes"} onClick={() => setTab("changes")}>{t("diff.title")}</TabButton>}
          <TabButton tabId="files" active={tab === "files"} onClick={() => setTab("files")}>{t("inspector.tab.files")}</TabButton>
          {!filesOnly && <TabButton tabId="transfers" active={tab === "transfers"} onClick={() => setTab("transfers")}>{t("inspector.tab.transfers")}</TabButton>}
          {!filesOnly && binding && <TabButton tabId="metadata" active={tab === "metadata"} onClick={() => setTab("metadata")}>{t("inspector.tab.metadata")}</TabButton>}
          {!filesOnly && isRemote && <TabButton tabId="forwarding" active={tab === "forwarding"} onClick={() => setTab("forwarding")}>{t("inspector.tab.forwarding")}</TabButton>}
          {!filesOnly && <TabButton tabId="diagnostics" active={tab === "diagnostics"} onClick={() => { diagnosticsCenter.open(); setTab("diagnostics"); }}>{t("inspector.tab.diagnostics")}</TabButton>}
          {!filesOnly && <TabButton tabId="knownHosts" active={tab === "knownHosts"} onClick={() => setTab("knownHosts")}>{t("inspector.tab.known_hosts")}</TabButton>}
          {!filesOnly && <TabButton tabId="preview" active={tab === "preview"} onClick={() => setTab("preview")}>{t("inspector.tab.preview")}</TabButton>}
          {!filesOnly && <TabButton tabId="notes" active={tab === "notes"} onClick={() => setTab("notes")}>{t("inspector.tab.notes")}</TabButton>}
        </div>

        {onClose && (
          <button
            onClick={onClose}
            title={t("diff.close_panel")}
            aria-label={t("diff.close_panel")}
            className="hover-bg"
            style={{
              width: "var(--h-titlebar-control)", height: "var(--h-titlebar-control)",
              borderRadius: "var(--r-btn)", border: "none", background: "transparent",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}
          >
            <CloseIcon size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {showSourceSummary && (
        <div style={{ minHeight: 28, padding: "4px 8px", display: "flex", alignItems: "center", gap: 6, background: "var(--c-bg-2)", borderBottom: "1px solid var(--c-border-1)", overflow: "hidden", flexShrink: 0 }}>
          <WorkspaceSourceChip session={session} />
          {tab === "changes" && !session.workspace && session.branch && (
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              ⎇ {session.branch}
            </span>
          )}
        </div>
      )}

      <div
        id="inspector-scope-description"
        style={{
          padding: "6px 10px",
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "3px 8px",
          borderBottom: "1px solid var(--c-border-1)",
          background: "var(--c-bg-2)",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <strong id="inspector-panel-title" style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
          {t(descriptor.titleKey)}
        </strong>
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
          {t(`inspector.scope.${scopeKey}`)}
        </span>
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", overflowWrap: "anywhere" }}>
          {t(scopeDescriptionKey)}
        </span>
      </div>

      <div
        role="tabpanel"
        id={INSPECTOR_TABPANEL_ID}
        aria-labelledby="inspector-panel-title"
        aria-describedby="inspector-scope-description"
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <div key={`${tab}:${inspectorScope.key}`} data-scope-key={inspectorScope.key} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, animation: "contentIn var(--duration-normal) var(--ease-out-expo)" }}>
          {activePanel}
        </div>
      </div>
    </div>
  );
}
