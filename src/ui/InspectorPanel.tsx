import type React from "react";
import { type Session } from "./types";
import { DiffPanel } from "./DiffPanel";
import { FileExplorer } from "./FileExplorer";
import { SessionOverviewPanel } from "./SessionOverviewPanel";
import { SessionNotesPanel } from "./SessionNotesPanel";
import { PreviewPanel } from "./PreviewPanel";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { CloseIcon, PanelEmptyState } from "./shared";
import { WorkspaceSourceChip } from "./WorkspaceSource";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";

interface InspectorPanelProps {
  session: Session;
  onClose?: () => void;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
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

export function InspectorPanel({ session, onClose }: InspectorPanelProps) {
  const t = useT();
  const storeTab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);
  const isRemote = !!session.remote;
  const tab = storeTab;
  const showSourceSummary = Boolean(
    currentWorkspaceWorktree(session.workspace)
    || session.workspaceState === "unavailable"
    || (tab === "changes" && !session.workspace && session.branch),
  );
  let activePanel: React.ReactNode;
  switch (tab) {
    case "changes":
      activePanel = <DiffPanel session={session} embedded />;
      break;
    case "files":
      activePanel = isRemote && session.ptyId === undefined ? (
        <PanelEmptyState
          icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          }
          label={t("inspector.remote_hint")}
          sublabel={session.dir}
        />
      ) : (
        <FileExplorer rootDir={session.dir} remotePtyId={isRemote ? session.ptyId : undefined} />
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

  return (
    <div style={{ width: "100%", background: "var(--c-bg-2)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ minHeight: "var(--h-titlebar)", background: "var(--c-bg-1)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", paddingLeft: 8, gap: 0, flexShrink: 0 }}>
        <div className="no-scrollbar" style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>{t("inspector.tab.overview")}</TabButton>
          <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>{t("diff.title")}</TabButton>
          <TabButton active={tab === "files"} onClick={() => setTab("files")}>{t("inspector.tab.files")}</TabButton>
          <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>{t("inspector.tab.preview")}</TabButton>
          <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>{t("inspector.tab.notes")}</TabButton>
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

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div key={tab} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, animation: "contentIn var(--duration-normal) var(--ease-out-expo)" }}>
          {activePanel}
        </div>
      </div>
    </div>
  );
}
