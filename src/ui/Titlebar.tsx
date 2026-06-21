import { deriveTitle, type Session } from "./types";
import { useUIStore } from "@/state/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { CloseIcon } from "./shared";

let _isMac = true;
try { _isMac = platform() === "macos"; } catch { _isMac = navigator.platform.toLowerCase().includes("mac"); }

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

function PanelLeftIcon({ active }: { active: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill={active ? "var(--c-accent)" : "currentColor"} fillOpacity={active ? 0.3 : 0.1} />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
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
        height: 28,
        padding: "0 10px",
        borderRadius: "var(--r-pill)",
        border: "none",
        background: isActive ? "var(--c-accent-bg-soft)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        transition: "background var(--duration-fast) ease",
      }}
    >
      {isActive && (
        <span style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: "var(--c-accent)",
          flexShrink: 0,
          animation: "scaleIn var(--duration-fast) var(--ease-out-back), subtlePulse 3s var(--ease-smooth) 0.5s infinite",
        }} />
      )}
      <span style={{
        fontSize: "var(--fs-secondary)",
        fontWeight: isActive ? 600 : 400,
        color: isActive ? "var(--c-text-primary)" : "var(--c-text-4)",
        fontFamily: "var(--font-ui)",
        transition: "color var(--duration-fast) var(--ease-smooth), font-weight var(--duration-fast) var(--ease-smooth)",
      }}>
        {label}
      </span>
      <span
        role="button"
        tabIndex={0}
        title="关闭"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
        className="tab-close hover-close"
        style={{
          width: 20, height: 20, borderRadius: "50%", display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}
      >
        <CloseIcon size={9} strokeWidth={2.5} />
      </span>
    </button>
  );
}

function WindowControls() {
  const win = getCurrentWindow();
  const btnBase: React.CSSProperties = {
    width: 28,
    height: 28,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-text-4)",
    borderRadius: "var(--r-btn)",
    flexShrink: 0,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        onClick={() => win.minimize()}
        title="最小化"
        className="hover-bg"
        style={btnBase}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title="最大化"
        className="hover-bg"
        style={btnBase}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
      </button>
      <button
        onClick={() => win.close()}
        title="关闭"
        className="hover-close"
        style={btnBase}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </div>
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
          <PanelLeftIcon active={sidebarVisible} />
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
            paddingLeft: 8,
            flex: 1,
            overflowX: "auto",
            overflowY: "hidden",
            animation: "tabsIn var(--duration-normal) ease",
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
          gap: 4,
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
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: panelVisible ? "var(--c-accent)" : undefined, transition: "color var(--duration-fast) ease" }}>
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <rect x="9" y="1.5" width="5.5" height="13" rx="2" fill={panelVisible ? "currentColor" : "none"} fillOpacity="0.3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        {!_isMac && <WindowControls />}
      </div>
    </div>
  );
}
