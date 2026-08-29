import {
  lazy,
  Suspense,
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
import {
  CloseIcon,
  PanelIconButton,
} from "./shared";
import { WorkspaceSourceChip } from "./WorkspaceSource";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "./lib/tab-list-navigation";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { INSPECTOR_TAB_DESCRIPTORS, resolveInspectorScope } from "./inspector-scope";
import { ContextMenu, type MenuEntry, type MenuItem } from "./ContextMenu";
import { INSPECTOR_OVERFLOW_SECTION, resolveInspectorNavigation } from "./inspector-navigation";
import { hasActivePreviewSource } from "@/modules/preview/preview-source";

const TransferCenter = lazy(() => import("./TransferCenter").then((module) => ({ default: module.TransferCenter })));
const ForwardingPanel = lazy(() => import("@/modules/ssh/ForwardingPanel").then((module) => ({ default: module.ForwardingPanel })));

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
        padding: "0 6px",
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
        transition: "border-color var(--duration-fast) var(--ease-smooth), color var(--duration-fast) var(--ease-smooth)",
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
    <PanelIconButton
      ref={buttonRef}
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      data-inspector-overflow-trigger
      data-active={expanded ? "true" : "false"}
      onClick={onClick}
      style={{
        marginRight: 2,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="7.5" r="1.15" />
        <circle cx="7.5" cy="7.5" r="1.15" />
        <circle cx="12" cy="7.5" r="1.15" />
      </svg>
    </PanelIconButton>
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
  const [moreMenu, setMoreMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);

  const navigation = resolveInspectorNavigation({
    filesOnly,
    isRemote,
    hasPreviewSource: hasActivePreviewSource(session.previewSources),
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
    setMoreMenu(null);
  }, [filesOnly, session.id]);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab)}"]`);
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const selectTab = (nextTab: InspectorTab) => {
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
      const item: MenuItem = {
        id: `inspector:${id}`,
        label: `${current ? "✓ " : ""}${t(INSPECTOR_TAB_DESCRIPTORS[id].titleKey)}`,
        action: () => selectTab(id),
      };
      const section = INSPECTOR_OVERFLOW_SECTION[id];
      const prevSection = index > 0 ? INSPECTOR_OVERFLOW_SECTION[navigation.secondary[index - 1]] : undefined;
      if (section && section !== prevSection) {
        const heading: MenuEntry = { type: "heading", label: t(`inspector.menu.${section}`) };
        return index > 0 ? [null, heading, item] : [heading, item];
      }
      return [item];
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
          gap: 0,
          flexShrink: 0,
        }}
      >
        <div
          ref={tabListRef}
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
            label={t("inspector.tab.more")}
            buttonRef={moreButtonRef}
            onClick={toggleMoreMenu}
          />
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
            animation: "contentIn var(--duration-normal) var(--ease-out-expo)",
          }}
        >
          <Suspense fallback={null}>
            {activePanel}
          </Suspense>
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
