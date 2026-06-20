import { deriveTitle, type Session } from "./types";
import { useUIStore } from "@/state/ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string; [key: string]: any };

interface TitlebarProps {
  sessions: Session[];
  activeSessionId: string;
  panelVisible: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
}

function PanelLeftIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill="var(--c-accent)" fillOpacity="0.3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function TabButton({ isActive, label, onSelect, onClose }: { isActive: boolean; label: string; onSelect: () => void; onClose: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="tab-btn"
      data-active={isActive ? "true" : "false"}
      style={{
        height: "var(--h-titlebar-tab)",
        padding: "7px 13px 8px",
        borderRadius: "var(--r-input) var(--r-input) 0 0",
        border: isActive ? "1px solid var(--c-border-2)" : "1px solid transparent",
        borderBottomColor: isActive ? "var(--c-bg-white)" : "transparent",
        background: isActive ? "var(--c-bg-white)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        position: "relative",
        alignSelf: "center",
        boxShadow: "none",
      }}
    >
      {isActive && (
        <div style={{
          position: "absolute",
          left: 8,
          right: 8,
          top: -1,
          height: 2,
          background: "var(--c-accent)",
          borderRadius: "2px 2px 0 0",
        }} />
      )}
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 500, color: isActive ? "var(--c-text-primary)" : "var(--c-text-4)", fontFamily: "var(--font-ui)" }}>
        {label}
      </span>
      <span
        role="button"
        tabIndex={0}
        title="关闭"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(); } }}
        className="tab-close hover-close"
        style={{
          width: 16, height: 16, borderRadius: 4, display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </span>
    </button>
  );
}

export function Titlebar({
  sessions,
  activeSessionId,
  panelVisible,
  sidebarVisible,
  onToggleSidebar,
  onTogglePanel,
  onSelectSession,
  onCloseSession,
  onNewTerminal,
  onOpenSettings,
}: TitlebarProps) {
  const showTabs = !sidebarVisible;
  const trafficLightWidth = useUIStore((s) => s.trafficLightWidth);

  function tabLabel(s: Session): string {
    const { primary } = deriveTitle(s);
    return primary.length > 24 ? primary.slice(0, 24) + "…" : primary;
  }

  return (
    <div
      style={{
        height: "var(--h-titlebar)",
        background: "var(--c-bg-1)",
        borderBottom: "1px solid var(--c-border-1)",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        position: "relative",
        WebkitAppRegion: "drag",
      } as DragStyle}
      data-tauri-drag-region
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {trafficLightWidth > 0 && <div style={{ width: trafficLightWidth, flexShrink: 0 }} />}
        <button
          onClick={onToggleSidebar}
          title="折叠侧边栏"
          style={{
            width: "var(--w-titlebar-control)",
            height: "var(--h-titlebar-control)",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          className="hover-bg"
        >
          <PanelLeftIcon />
        </button>
      </div>

      {showTabs ? (
        <div
          className="no-scrollbar"
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            gap: 6,
            flex: 1,
            overflowX: "auto",
            overflowY: "hidden",
            WebkitAppRegion: "no-drag",
          } as DragStyle}
        >
          {sessions.map((s) => (
            <TabButton
              key={s.id}
              isActive={s.id === activeSessionId}
              label={tabLabel(s)}
              onSelect={() => onSelectSession(s.id)}
              onClose={() => onCloseSession(s.id)}
            />
          ))}
          <button
            onClick={onNewTerminal}
            title="新建终端 ⌘T"
            style={{
              width: "var(--w-titlebar-control)",
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
            className="hover-bg"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      ) : (
        <div style={{ flex: 1 }} />
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingRight: 12,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        <button
          onClick={onOpenSettings}
          title="设置 ⌘,"
          style={{
            width: "var(--w-titlebar-control)",
            height: "var(--h-titlebar-control)",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          className="hover-bg"
        >
          <GearIcon />
        </button>

        <button
          onClick={onTogglePanel}
          title={panelVisible ? "隐藏审查面板" : "显示审查面板"}
          style={{
            width: "var(--w-titlebar-control)",
            height: "var(--h-titlebar-control)",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          className="hover-bg"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <rect x="9" y="1.5" width="5.5" height="13" rx="2" fill={panelVisible ? "currentColor" : "none"} fillOpacity="0.3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
