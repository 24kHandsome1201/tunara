import {
  Activity,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type Session } from "./types";
import { FileExplorer } from "./FileExplorer";
import { PreviewPanel } from "./PreviewPanel";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import type { InspectorTab } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  CloseIcon,
  PanelIconButton,
  PanelLoadingState,
} from "./shared";
import { DotsThree, Icon } from "@/ui/icons";
import { ContextMenu } from "./ContextMenu";
import { WorkspaceSourceChip } from "./WorkspaceSource";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "./lib/tab-list-navigation";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { INSPECTOR_TAB_DESCRIPTORS, resolveInspectorScope } from "./inspector-scope";
import { resolveInspectorNavigation } from "./inspector-navigation";
import { hasActivePreviewSource } from "@/modules/preview/preview-source";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { statusMultiplexer } from "@/modules/session/multiplexer-status";
import { useMultiplexerSummary } from "@/state/multiplexer-status";
import { sessionTerminalMultiplexer } from "@/modules/session/terminal-multiplexer";

const DiffPanel = lazy(() => import("./DiffPanel").then((module) => ({ default: module.DiffPanel })));
const TransferCenter = lazy(() => import("./TransferCenter").then((module) => ({ default: module.TransferCenter })));
const ForwardingPanel = lazy(() => import("@/modules/ssh/ForwardingPanel").then((module) => ({ default: module.ForwardingPanel })));

const INSPECTOR_TABPANEL_ID = "inspector-tabpanel";

interface InspectorPanelProps {
  session: Session;
  onClose?: () => void;
  filesOnly?: boolean;
}

function SwitcherButton({
  active,
  onClick,
  label,
  tabId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tabId: InspectorTab;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={INSPECTOR_TABPANEL_ID}
      aria-label={label}
      title={label}
      data-tab-id={tabId}
      tabIndex={active ? 0 : -1}
      data-active={active ? "true" : "false"}
      className="inspector-tab"
    >
      {label}
      {children}
    </button>
  );
}

function useInspectorPaneCwd(session: Session) {
  return useMultiplexerSummary(
    !session.remote && statusMultiplexer(sessionTerminalMultiplexer(session)) ? session.id : null,
  )?.focusedCwd ?? null;
}

function SessionFileExplorer({ session, active, remoteHostTitle }: { session: Session; active: boolean; remoteHostTitle?: string }) {
  const paneCwd = useInspectorPaneCwd(session);
  const live = session.connection?.phase === "ready";
  return (
    <FileExplorer
      key={paneCwd ?? "terminal-cwd"}
      active={active}
      sessionId={session.id}
      rootDir={paneCwd ?? session.dir}
      remotePtyId={session.remote && live ? session.ptyId : undefined}
      transportGeneration={live ? session.transportGeneration : undefined}
      remote={Boolean(session.remote)}
      remoteHost={session.remote ? `${session.remote.user}@${session.remote.host}` : undefined}
      remoteHostTitle={remoteHostTitle}
    />
  );
}

export function InspectorPanel({ session: terminalSession, onClose, filesOnly = false }: InspectorPanelProps) {
  const t = useT();
  const paneCwd = useInspectorPaneCwd(terminalSession);
  const session = useMemo(
    () => (paneCwd ? { ...terminalSession, dir: paneCwd } : terminalSession),
    [terminalSession, paneCwd],
  );
  const storeTab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);
  const previewOpened = useUIStore((s) => Boolean(s.inspectorPreviewOpenedSessionIds[session.id]));
  const isRemote = !!session.remote;
  const binding: SessionBindingV1 | null = isRemote && session.ptyId !== undefined && session.transportGeneration
    ? { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration }
    : null;
  const forwardingBinding = session.connection?.phase === "ready" ? binding : null;
  const tabListRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasPreviewSource = hasActivePreviewSource(session.previewSources);
  const transferCount = useTransferStore((s) => {
    const aggregate = s.aggregateBySession.get(session.id);
    return (aggregate?.queued ?? 0) + (aggregate?.running ?? 0);
  });

  const navigation = resolveInspectorNavigation({
    filesOnly,
    isRemote,
    previewAvailable: hasPreviewSource || previewOpened,
    hasInProgressTransfer: transferCount > 0,
    current: storeTab,
  });
  const tab = filesOnly ? "files" : navigation.all.includes(storeTab) ? storeTab : "files";
  const sessions = useSessionsStore((s) => s.sessions);
  const [visitedFiles, setVisitedFiles] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (tab === "files") {
      setVisitedFiles((visited) => visited.has(session.id) ? visited : new Set([...visited, session.id]));
    }
  }, [tab, session.id]);
  const fileSessions = [
    ...sessions.filter((candidate) => candidate.id !== session.id && visitedFiles.has(candidate.id)),
    ...(tab === "files" || visitedFiles.has(session.id) ? [terminalSession] : []),
  ];
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
  const showScopeDescription = showSourceSummary || isRemote;
  const showContextBar = showSourceSummary || (isRemote && tab !== "files");
  const scopeTitle = `${session.dir}\n${t(scopeDescriptionKey)}`;

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab)}"]`);
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const selectTab = (nextTab: InspectorTab) => {
    setTab(nextTab, { sessionId: session.id });
  };

  let activePanel: ReactNode;
  switch (tab) {
    case "changes":
      activePanel = <DiffPanel session={session} embedded />;
      break;
    case "transfers":
      activePanel = <TransferCenter inspectorScope={inspectorScope} />;
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
    case "preview":
      activePanel = <PreviewPanel session={session} />;
      break;
  }

  const handleTabListKeyDown = (event: KeyboardEvent) => {
    const currentId = tabIdFromEventTarget(event.target);
    if (!currentId) return;
    const nextId = resolveRovingTabId(navigation.primary, currentId, event.key);
    if (!nextId || nextId === currentId) return;
    event.preventDefault();
    selectTab(nextId as InspectorTab);
    focusTabById(event.currentTarget as HTMLElement, nextId);
  };

  return (
    <div
      style={{
        width: "100%",
        background: "var(--c-workspace-tools)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <div className="tunara-translucent-layer inspector-toolbar">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t("inspector.tab.aria_label")}
          onKeyDown={filesOnly ? undefined : handleTabListKeyDown}
          className={filesOnly ? "inspector-files-tab no-scrollbar" : "inspector-tab-list"}
        >
          {filesOnly ? (
            <SwitcherButton tabId="files" active label={t(INSPECTOR_TAB_DESCRIPTORS.files.titleKey)} onClick={() => {}}>
              {null}
            </SwitcherButton>
          ) : navigation.primary.map((id) => (
            <SwitcherButton
              key={id}
              tabId={id}
              active={tab === id}
              label={t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey)}
              onClick={() => selectTab(id)}
            >
              {id === "changes" && !!session.changes?.files.length && <span>{session.changes.files.length}</span>}
              {id === "transfers" && transferCount > 0 && <span>{transferCount}</span>}
            </SwitcherButton>
          ))}
        </div>

        {!filesOnly && navigation.secondary.length > 0 && (
          <PanelIconButton
            className="workspace-reveal-action"
            aria-label={t("inspector.more")}
            title={t("inspector.more")}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom });
            }}
          >
            <Icon icon={DotsThree} size={18} />
          </PanelIconButton>
        )}
        {onClose && (
          <PanelIconButton
            className="workspace-reveal-action"
            onClick={onClose}
            title={t("diff.close_panel")}
            aria-label={t("diff.close_panel")}
          >
            <CloseIcon size={13} strokeWidth={2.2} />
          </PanelIconButton>
        )}
      </div>

      {menu && <ContextMenu
        position={menu}
        items={navigation.secondary.map((id) => ({ id, label: t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey), action: () => selectTab(id) }))}
        onClose={() => setMenu(null)}
      />}
      {showContextBar && (
        <div
          className="tunara-translucent-layer"
          id="inspector-context-bar"
        >
          <span
            title={scopeTitle}
            className="inspector-context-badge"
          >
            {session.remote ? `${session.remote.user}@${session.remote.host}` : session.dir.split(/[\\/]/).filter(Boolean).pop() || session.dir}
          </span>
          <span className="inspector-context-spacer" />
          {showSourceSummary && (
            <div className="inspector-source-summary">
              <WorkspaceSourceChip session={session} />
              {!session.workspace && session.branch && (
                <span className="inspector-source-branch">
                  ⎇ {session.branch}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {showScopeDescription && (
        <span id="inspector-scope-description" className="sr-only">
          {session.remote ? `${session.remote.user}@${session.remote.host}: ${session.dir}` : session.dir}
        </span>
      )}

      <div
        role="tabpanel"
        id={INSPECTOR_TABPANEL_ID}
        aria-label={t(descriptor.titleKey)}
        aria-describedby={showScopeDescription ? "inspector-scope-description" : undefined}
        className="inspector-panel-content"
      >
        {fileSessions.map((fileSession) => {
          const active = tab === "files" && fileSession.id === session.id;
          return (
            <Activity key={fileSession.id} mode={active ? "visible" : "hidden"}>
              <SessionFileExplorer session={fileSession} active={active} remoteHostTitle={active ? scopeTitle : undefined} />
            </Activity>
          );
        })}
        {tab !== "files" && <div
          key={`${tab}:${inspectorScope.key}`}
          data-scope-key={inspectorScope.key}
          className="inspector-panel-content"
        >
          <Suspense fallback={<PanelLoadingState label={t("diff.mini.loading")} />}>
            {activePanel}
          </Suspense>
        </div>}
      </div>
    </div>
  );
}
