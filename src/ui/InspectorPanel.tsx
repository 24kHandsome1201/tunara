import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
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
import {
  listKnownHostsV1,
  refreshKnownHostsV1,
  removeKnownHostV1,
  type KnownHostsSnapshotV1,
} from "@/modules/ssh/known-hosts-bridge";
import { ForwardingPanel } from "@/modules/ssh/ForwardingPanel";
import { copyText } from "./lib/clipboard";
import { INSPECTOR_TAB_DESCRIPTORS, resolveInspectorScope } from "./inspector-scope";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { resolveInspectorNavigation } from "./inspector-navigation";

const INSPECTOR_TABPANEL_ID = "inspector-tabpanel";

interface InspectorPanelProps {
  session: Session;
  onClose?: () => void;
  filesOnly?: boolean;
}

function TabButton({
  active,
  onClick,
  children,
  tabId,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  tabId: InspectorTab;
}) {
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

function MoreToolsButton({
  expanded,
  label,
  buttonRef,
  onClick,
}: {
  expanded: boolean;
  label: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      data-inspector-overflow-trigger
      onClick={onClick}
      className="hover-bg"
      style={{
        width: 34,
        height: 34,
        marginRight: 2,
        borderRadius: "var(--r-btn)",
        border: "none",
        background: expanded ? "var(--c-accent-bg-soft)" : "transparent",
        color: expanded ? "var(--c-text-primary)" : "var(--c-text-5)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="7.5" r="1.15" />
        <circle cx="7.5" cy="7.5" r="1.15" />
        <circle cx="12" cy="7.5" r="1.15" />
      </svg>
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
                if (pendingRemove !== entry.entryId) {
                  setPendingRemove(entry.entryId);
                  return;
                }
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
  const [moreMenu, setMoreMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const navigation = resolveInspectorNavigation({
    filesOnly,
    isRemote,
    hasBinding: binding !== null,
  });
  const tab = filesOnly ? "files" : navigation.all.includes(storeTab) ? storeTab : "overview";
  const secondaryTabActive = navigation.secondary.includes(tab);
  const visibleTabIds = secondaryTabActive ? [...navigation.primary, tab] : navigation.primary;
  const descriptor = INSPECTOR_TAB_DESCRIPTORS[tab];
  const inspectorScope = resolveInspectorScope(descriptor, session, binding);
  const scopeKey = inspectorScope.kind.replace("-", "_");
  const scopeDescriptionKey = inspectorScope.kind === descriptor.scope
    ? descriptor.descriptionKey
    : `inspector.scope.description.${scopeKey}`;
  const showSourceSummary = tab === "changes" && Boolean(
    currentWorkspaceWorktree(session.workspace)
    || session.workspaceState === "unavailable"
    || (!session.workspace && session.branch),
  );
  const showContextBar = showSourceSummary || inspectorScope.kind !== "logical-session";

  useEffect(() => {
    setMetadataPath(session.dir);
    setMoreMenu(null);
  }, [filesOnly, session.dir, session.id]);

  const selectTab = (nextTab: InspectorTab) => {
    if (nextTab === "diagnostics") diagnosticsCenter.open();
    setTab(nextTab);
    setMoreMenu(null);
  };

  const toggleMoreMenu = (event: MouseEvent<HTMLButtonElement>) => {
    if (moreMenu) {
      setMoreMenu(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const items = navigation.secondary.flatMap<MenuEntry>((id, index) => {
      const current = id === tab;
      const item: MenuEntry = {
        id: `inspector:${id}`,
        label: `${current ? "✓ " : ""}${t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey)}`,
        action: () => selectTab(id),
      };
      const addSeparator = index > 0 && (id === "transfers" || id === "diagnostics");
      return addSeparator ? [null, item] : [item];
    });

    setMoreMenu({
      items,
      position: { x: Math.max(8, rect.right - 192), y: rect.bottom },
    });
  };

  let activePanel: ReactNode;
  switch (tab) {
    case "changes":
      activePanel = <DiffPanel session={session} embedded />;
      break;
    case "files":
      activePanel = (
        <FileExplorer
          sessionId={session.id}
          rootDir={session.dir}
          remotePtyId={isRemote ? session.ptyId : undefined}
          transportGeneration={session.transportGeneration}
          remote={isRemote}
          remoteHost={session.remote ? `${session.remote.user}@${session.remote.host}` : undefined}
          onInspectRemotePath={(path) => {
            setMetadataPath(path);
            selectTab("metadata");
          }}
        />
      );
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
      activePanel = (
        <ForwardingPanel
          key={`${session.id}:${forwardingBinding?.physicalPtyId ?? "offline"}:${forwardingBinding?.transportGeneration ?? "none"}`}
          binding={forwardingBinding}
          session={session}
        />
      );
      break;
    case "diagnostics":
      activePanel = (
        <DiagnosticsCenter
          sessionId={session.id}
          onClose={() => selectTab("overview")}
          onCopyReport={async (report) => {
            const copied = await copyText(report);
            useUIStore.getState().addToast({
              sessionId: session.id,
              title: t(copied ? "diagnostics.copy_succeeded" : "diagnostics.copy_failed"),
              subtitle: "",
              variant: copied ? "success" : "error",
            });
          }}
        />
      );
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

  const handleTabListKeyDown = (event: KeyboardEvent) => {
    const currentId = tabIdFromEventTarget(event.target);
    if (!currentId) return;
    const nextId = resolveRovingTabId(visibleTabIds, currentId, event.key);
    if (!nextId || nextId === currentId) return;
    event.preventDefault();
    selectTab(nextId as InspectorTab);
    focusTabById(event.currentTarget as HTMLElement, nextId);
  };

  return (
    <div
      style={{
        width: "100%",
        background: "var(--c-bg-2)",
        borderLeft: "1px solid var(--c-border-1)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          minHeight: "var(--h-titlebar)",
          background: "var(--c-bg-1)",
          borderBottom: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          paddingLeft: 8,
          gap: 0,
          flexShrink: 0,
        }}
      >
        <div
          className="no-scrollbar"
          role="tablist"
          aria-label={t("inspector.tab.aria_label")}
          onKeyDown={handleTabListKeyDown}
          style={{
            display: "flex",
            alignItems: "center",
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            overflowY: "hidden",
          }}
        >
          {navigation.primary.map((id) => (
            <TabButton key={id} tabId={id} active={tab === id} onClick={() => selectTab(id)}>
              {t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey)}
            </TabButton>
          ))}
          {secondaryTabActive && (
            <TabButton key={`secondary:${tab}`} tabId={tab} active onClick={() => selectTab(tab)}>
              {t(descriptor.titleKey)}
            </TabButton>
          )}
        </div>

        {!filesOnly && navigation.secondary.length > 0 && (
          <MoreToolsButton
            expanded={moreMenu !== null}
            label={t("inspector.tab.aria_label")}
            buttonRef={moreButtonRef}
            onClick={toggleMoreMenu}
          />
        )}

        {onClose && (
          <button
            onClick={onClose}
            title={t("diff.close_panel")}
            aria-label={t("diff.close_panel")}
            className="hover-bg"
            style={{
              width: "var(--h-titlebar-control)",
              height: "var(--h-titlebar-control)",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <CloseIcon size={13} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {showContextBar && (
        <div
          id="inspector-context-bar"
          style={{
            minHeight: 28,
            padding: "3px 9px 3px 10px",
            display: "flex",
            alignItems: "center",
            gap: 7,
            borderBottom: "1px solid var(--c-border-1)",
            background: "var(--c-bg-2)",
            flexShrink: 0,
            minWidth: 0,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <span
            title={t(scopeDescriptionKey)}
            style={{
              flexShrink: 0,
              padding: "1px 6px",
              borderRadius: "var(--r-pill)",
              background: "var(--c-bg-3)",
              color: "var(--c-text-5)",
              fontSize: "var(--fs-badge)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {t(`inspector.scope.${scopeKey}`)}
          </span>
          <span style={{ flex: 1, minWidth: 0 }} />
          {showSourceSummary && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
              <WorkspaceSourceChip session={session} />
              {!session.workspace && session.branch && (
                <span
                  style={{
                    fontSize: "var(--fs-meta)",
                    color: "var(--c-text-5)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  ⎇ {session.branch}
                </span>
              )}
            </div>
          )}
          <span
            id="inspector-scope-description"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {t(scopeDescriptionKey)}
          </span>
        </div>
      )}

      <div
        role="tabpanel"
        id={INSPECTOR_TABPANEL_ID}
        aria-label={t(descriptor.titleKey)}
        aria-describedby={showContextBar ? "inspector-scope-description" : undefined}
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <div
          key={`${tab}:${inspectorScope.key}`}
          data-scope-key={inspectorScope.key}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            animation: "contentIn var(--duration-normal) var(--ease-out-expo)",
          }}
        >
          {activePanel}
        </div>
      </div>

      {moreMenu && (
        <ContextMenu
          items={moreMenu.items}
          position={moreMenu.position}
          onClose={() => setMoreMenu(null)}
          returnFocusToken={moreButtonRef}
        />
      )}
    </div>
  );
}
