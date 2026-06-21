import { type Session } from "./types";
import { DiffPanel } from "./DiffPanel";
import { FileExplorer } from "./FileExplorer";
import { useUIStore } from "@/state/ui";

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
        color: active ? "var(--c-text-primary)" : "var(--c-text-5)",
        transition: "background var(--duration-fast) ease, color var(--duration-fast) ease",
      }}
      className={active ? undefined : "hover-text-3"}
    >
      {children}
    </button>
  );
}

export function InspectorPanel({ session, onClose }: InspectorPanelProps) {
  const tab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);

  return (
    <div style={{ width: "100%", background: "var(--c-bg-2-glass)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      {/* title bar */}
      <div style={{ height: "var(--h-titlebar)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 12px", gap: 4, flexShrink: 0 }}>
        <TabButton active={tab === "changes"} onClick={() => setTab("changes")}>改动</TabButton>
        <TabButton active={tab === "files"} onClick={() => setTab("files")}>文件</TabButton>

        <span style={{ flex: 1 }} />

        {tab === "changes" && session.branch && (
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
            ⎇ {session.branch}
          </span>
        )}

        {onClose && (
          <button
            onClick={onClose}
            title="关闭面板 ⌘⇧\"
            className="hover-bg"
            style={{
              width: "var(--h-titlebar-control)", height: "var(--h-titlebar-control)",
              borderRadius: "var(--r-btn)", border: "none", background: "transparent",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flex: 1, display: tab === "changes" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
          <DiffPanel session={session} embedded />
        </div>
        <div style={{ flex: 1, display: tab === "files" ? "flex" : "none", flexDirection: "column", minHeight: 0 }}>
          <FileExplorer rootDir={session.dir} />
        </div>
      </div>
    </div>
  );
}
