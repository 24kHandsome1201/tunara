import type React from "react";
import { type Session } from "./types";
import { DiffPanel } from "./DiffPanel";
import { FileExplorer } from "./FileExplorer";
import { SessionOverviewPanel } from "./SessionOverviewPanel";
import { SessionNotesPanel } from "./SessionNotesPanel";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { CloseIcon } from "./shared";

interface InspectorPanelProps {
  session: Session;
  onClose?: () => void;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26,
        padding: "0 10px",
        borderRadius: "var(--r-pill)",
        border: "none",
        background: active ? "var(--c-accent-bg-soft)" : "transparent",
        cursor: "pointer",
        fontSize: "var(--fs-secondary)",
        fontWeight: active ? 600 : 400,
        color: active ? "var(--c-text-primary)" : "var(--c-text-4)",
        transition: "background var(--duration-normal) var(--ease-smooth), color var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
        boxShadow: active ? "var(--shadow-card)" : "none",
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
  const tab = isRemote && storeTab === "changes" ? "files" : storeTab;

  return (
    <div style={{ width: "100%", background: "var(--c-bg-2-glass)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      <div style={{ height: "var(--h-titlebar)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 12px", gap: 4, flexShrink: 0 }}>
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>{t("inspector.tab.overview")}</TabButton>
        {!isRemote && (
          <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>{t("diff.title")}</TabButton>
        )}
        <TabButton active={tab === "files"} onClick={() => setTab("files")}>{t("inspector.tab.files")}</TabButton>
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>{t("inspector.tab.notes")}</TabButton>

        <span style={{ flex: 1 }} />

        {tab === "changes" && session.branch && (
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
            ⎇ {session.branch}
          </span>
        )}

        {onClose && (
          <button
            onClick={onClose}
            title={t("diff.close_panel")}
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

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div key={`overview-${tab}`} style={{ flex: 1, display: tab === "overview" ? "flex" : "none", flexDirection: "column", minHeight: 0, animation: tab === "overview" ? "contentIn var(--duration-normal) var(--ease-out-expo)" : undefined }}>
          <SessionOverviewPanel session={session} />
        </div>
        {!isRemote && (
          <div key={`changes-${tab}`} style={{ flex: 1, display: tab === "changes" ? "flex" : "none", flexDirection: "column", minHeight: 0, animation: tab === "changes" ? "contentIn var(--duration-normal) var(--ease-out-expo)" : undefined }}>
            <DiffPanel session={session} embedded />
          </div>
        )}
        <div key={`files-${tab}`} style={{ flex: 1, display: tab === "files" ? "flex" : "none", flexDirection: "column", minHeight: 0, animation: tab === "files" ? "contentIn var(--duration-normal) var(--ease-out-expo)" : undefined }}>
          {isRemote && session.ptyId === undefined ? (
            <div style={{ padding: 16, fontSize: "var(--fs-secondary)", color: "var(--c-text-5)" }}>
              {t("inspector.remote_hint")}
            </div>
          ) : (
            <FileExplorer rootDir={session.dir} remotePtyId={isRemote ? session.ptyId : undefined} />
          )}
        </div>
        <div key={`notes-${tab}`} style={{ flex: 1, display: tab === "notes" ? "flex" : "none", flexDirection: "column", minHeight: 0, animation: tab === "notes" ? "contentIn var(--duration-normal) var(--ease-out-expo)" : undefined }}>
          <SessionNotesPanel session={session} />
        </div>
      </div>
    </div>
  );
}
