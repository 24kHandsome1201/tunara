import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type Session } from "./types";
import { FileExplorer } from "./FileExplorer";
import { PreviewPanel } from "./PreviewPanel";
import { useUIStore } from "@/state/ui";
import type { InspectorTab } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  CloseIcon,
  PanelIconButton,
  PanelLoadingState,
} from "./shared";
import { AlignLeftSimple, AppWindow, ArrowsDownUp, FolderSimple, Icon, ShareNetwork } from "@/ui/icons";
import { WorkspaceSourceChip } from "./WorkspaceSource";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "./lib/tab-list-navigation";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { INSPECTOR_TAB_DESCRIPTORS, resolveInspectorScope } from "./inspector-scope";
import { resolveInspectorNavigation } from "./inspector-navigation";
import { hasActivePreviewSource } from "@/modules/preview/preview-source";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import {
  hasUnreviewedGitChanges,
  isViewingInspectorFiles,
  resolveInspectorAutoSwitch,
  resolveInspectorAutoView,
  sessionHasInProgressTransfer,
} from "./inspector-context";

const DiffPanel = lazy(() => import("./DiffPanel").then((module) => ({ default: module.DiffPanel })));
const TransferCenter = lazy(() => import("./TransferCenter").then((module) => ({ default: module.TransferCenter })));
const ForwardingPanel = lazy(() => import("@/modules/ssh/ForwardingPanel").then((module) => ({ default: module.ForwardingPanel })));

const INSPECTOR_TABPANEL_ID = "inspector-tabpanel";

const INSPECTOR_TAB_ICONS: Record<InspectorTab, ReactNode> = {
  changes: <Icon icon={AlignLeftSimple} size={14} />,
  files: <Icon icon={FolderSimple} size={14} />,
  preview: <Icon icon={AppWindow} size={14} />,
  transfers: <Icon icon={ArrowsDownUp} size={14} />,
  forwarding: <Icon icon={ShareNetwork} size={14} />,
};

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
    <PanelIconButton
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-controls={INSPECTOR_TABPANEL_ID}
      aria-label={label}
      title={label}
      data-tab-id={tabId}
      tabIndex={active ? 0 : -1}
      data-active={active ? "true" : "false"}
      className={active ? "inspector-tab" : "inspector-tab hover-text-3"}
    >
      {children}
    </PanelIconButton>
  );
}

export function InspectorPanel({ session, onClose, filesOnly = false }: InspectorPanelProps) {
  const t = useT();
  const storeTab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);
  const inspectorLocked = useUIStore((s) => s.inspectorLocked);
  const previewOpened = useUIStore((s) => Boolean(s.inspectorPreviewOpenedSessionIds[session.id]));
  const markInspectorPreviewOpened = useUIStore((s) => s.markInspectorPreviewOpened);
  const focusedPaneId = useUIStore((s) => s.focusedPaneId);
  const readerOpen = useUIStore((s) => Boolean(s.readers[session.id]?.current));
  const isRemote = !!session.remote;
  const binding: SessionBindingV1 | null = isRemote && session.ptyId !== undefined && session.transportGeneration
    ? { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration }
    : null;
  const forwardingBinding = session.connection?.phase === "ready" ? binding : null;
  const tabListRef = useRef<HTMLDivElement>(null);

  const navigation = resolveInspectorNavigation({
    filesOnly,
    isRemote,
  });
  const tab = filesOnly ? "files" : navigation.all.includes(storeTab) ? storeTab : "changes";
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
  const hasPreviewSource = hasActivePreviewSource(session.previewSources);
  const hasInProgressTransfer = useTransferStore((s) =>
    sessionHasInProgressTransfer(s.aggregateBySession.get(session.id)),
  );
  const recommended = resolveInspectorAutoView({
    isRemote,
    hasUnreviewedChanges: hasUnreviewedGitChanges(session),
    previewOpened,
    hasActivePreviewSource: hasPreviewSource,
    hasInProgressTransfer,
  });
  const viewingFiles = isViewingInspectorFiles({
    currentTab: tab,
    hasActiveFileTab: readerOpen && focusedPaneId === `reader:${session.id}`,
  });
  const autoSwitch = filesOnly
    ? { recommended, apply: false, defer: false }
    : resolveInspectorAutoSwitch({
        locked: inspectorLocked,
        current: tab,
        recommended,
        viewingFiles,
      });

  useEffect(() => {
    useUIStore.getState().syncInspectorLockForSession(session.id);
  }, [session.id]);

  useEffect(() => {
    if (filesOnly || !autoSwitch.apply) return;
    setTab(autoSwitch.recommended, { lock: false, sessionId: session.id });
  }, [autoSwitch.apply, autoSwitch.recommended, filesOnly, session.id, setTab]);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab)}"]`);
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const selectTab = (nextTab: InspectorTab) => {
    setTab(nextTab, { sessionId: session.id });
    if (nextTab === "preview") markInspectorPreviewOpened(session.id);
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
        />
      );
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
        background: "var(--c-bg-1)",
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
          gap: 4,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: "var(--fs-secondary)",
            fontWeight: 600,
            color: "var(--c-text-primary)",
            whiteSpace: "nowrap",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            paddingRight: 4,
          }}
        >
          {t(descriptor.titleKey)}
        </span>

        <div style={{ flex: 1, minWidth: 0 }} />

        {!filesOnly && (
          <div
            ref={tabListRef}
            className="no-scrollbar"
            role="tablist"
            aria-label={t("inspector.tab.aria_label")}
            onKeyDown={handleTabListKeyDown}
            style={{
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            {navigation.primary.map((id) => (
              <SwitcherButton
                key={id}
                tabId={id}
                active={tab === id}
                label={t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey)}
                onClick={() => selectTab(id)}
              >
                {INSPECTOR_TAB_ICONS[id]}
              </SwitcherButton>
            ))}
          </div>
        )}

        {filesOnly && (
          <div
            ref={tabListRef}
            className="no-scrollbar"
            role="tablist"
            aria-label={t("inspector.tab.aria_label")}
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            <SwitcherButton tabId="files" active label={t(INSPECTOR_TAB_DESCRIPTORS.files.titleKey)} onClick={() => {}}>
              {INSPECTOR_TAB_ICONS.files}
            </SwitcherButton>
          </div>
        )}

        {onClose && (
          <PanelIconButton
            onClick={onClose}
            title={t("diff.close_panel")}
            aria-label={t("diff.close_panel")}
          >
            <CloseIcon size={13} strokeWidth={2.2} />
          </PanelIconButton>
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
            background: "var(--c-bg-1)",
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
              fontSize: "var(--fs-meta)",
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
          }}
        >
          <Suspense fallback={<PanelLoadingState label={t("diff.mini.loading")} />}>
            {activePanel}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
