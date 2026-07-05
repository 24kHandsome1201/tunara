import { useEffect, useRef, useState } from "react";
import { deriveTitle, type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { getNumberRecordValue } from "@/state/record-keys";
import { useUIStore } from "@/state/ui";
import { formatShortcut } from "./formatShortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { CloseIcon } from "./shared";
import { useT } from "@/modules/i18n";

let _isMac = true;
try { _isMac = platform() === "macos"; } catch { _isMac = navigator.platform.toLowerCase().includes("mac"); }

// WebKit's `-webkit-app-region` CSS property is not in the standard
// React.CSSProperties type. Model just the one vendor extension we use.
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string };

const TITLEBAR_ICON_STYLE: React.CSSProperties = { width: 16, height: 16, flexShrink: 0 };
const MAC_TITLEBAR_CONTROL_Y_OFFSET = -1;

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
    <svg style={TITLEBAR_ICON_STYLE} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill={active ? "var(--c-accent)" : "currentColor"} fillOpacity={active ? 0.3 : 0.1} />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg style={TITLEBAR_ICON_STYLE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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

function TabButton({ isActive, label, closeLabel, confirmCloseLabel, confirmClose, onSelect, onClose }: { isActive: boolean; label: string; closeLabel: string; confirmCloseLabel: string; confirmClose?: boolean; onSelect: () => void; onClose: () => void }) {
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
        title={confirmClose ? confirmCloseLabel : closeLabel}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
        className="tab-close hover-close"
        style={{
          width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
          color: confirmClose ? "var(--c-error)" : undefined,
        }}
      >
        <CloseIcon size={10} strokeWidth={2.2} />
      </span>
    </button>
  );
}

function WindowControls() {
  const t = useT();
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
        title={t("titlebar.window.minimize")}
        className="hover-bg"
        style={btnBase}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={t("titlebar.window.maximize")}
        className="hover-bg"
        style={btnBase}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
      </button>
      <button
        onClick={() => win.close()}
        title={t("titlebar.window.close")}
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
  const t = useT();
  const showTabs = !sidebarVisible;
  const trafficLightWidth = useUIStore((s) => s.trafficLightWidth);
  const closeConfirmations = useSessionsStore((s) => s.closeConfirmations);
  const newTerminalShortcut = useUIStore((s) => s.keybindings.newTerminal);
  const openSettingsShortcut = useUIStore((s) => s.keybindings.openSettings);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflowEdge, setOverflowEdge] = useState<"none" | "left" | "right" | "both">("none");

  function tabLabel(s: Session): string {
    const { primary } = deriveTitle(s);
    return primary.length > 24 ? primary.slice(0, 24) + "…" : primary;
  }

  // 监听 tabs 容器滚动，决定哪边显示渐隐提示
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs) return;
    const update = () => {
      const canLeft = el.scrollLeft > 1;
      const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setOverflowEdge(canLeft && canRight ? "both" : canLeft ? "left" : canRight ? "right" : "none");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [showTabs, sessions.length]);

  // 鼠标滚轮 → 横向滚动（trackpad 横滑天生工作，无需介入）
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return; // trackpad 横滑，浏览器已经处理
      if (e.deltaY === 0) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      if (maxScroll <= 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showTabs]);

  // active tab 自动滚入视野
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs || !activeSessionId) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeSessionId}"]`);
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 16);
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 16;
  }, [activeSessionId, showTabs, sessions.length]);

  const tabsMask =
    overflowEdge === "both"
      ? "linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)"
      : overflowEdge === "left"
        ? "linear-gradient(to right, transparent 0, #000 24px)"
        : overflowEdge === "right"
          ? "linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)"
          : undefined;
  const titlebarControlTransform = _isMac ? `translateY(${MAC_TITLEBAR_CONTROL_Y_OFFSET}px)` : undefined;

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
          transform: titlebarControlTransform,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {trafficLightWidth > 0 && <div style={{ width: trafficLightWidth, flexShrink: 0 }} />}
        <button
          onClick={onToggleSidebar}
          title={t("titlebar.toggle_sidebar")}
          aria-label={t("titlebar.toggle_sidebar")}
          aria-pressed={sidebarVisible}
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
          ref={tabsRef}
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
            transform: titlebarControlTransform,
            WebkitAppRegion: "no-drag",
            maskImage: tabsMask,
            WebkitMaskImage: tabsMask,
          } as DragStyle}
        >
          {sessions.map((s) => (
            <div key={s.id} data-tab-id={s.id} style={{ flexShrink: 0 }}>
              <TabButton
                isActive={s.id === activeSessionId}
                label={tabLabel(s)}
                closeLabel={t("titlebar.tab.close")}
                confirmCloseLabel={t("session.close.confirm_again")}
                confirmClose={getNumberRecordValue(closeConfirmations, s.id) > 0}
                onSelect={() => onSelectSession(s.id)}
                onClose={() => onCloseSession(s.id)}
              />
            </div>
          ))}
          <button
            onClick={onNewTerminal}
            title={`${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
            aria-label={`${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
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
          transform: titlebarControlTransform,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >

        <button
          onClick={onOpenSettings}
          title={`${t("titlebar.settings")} ${formatShortcut(openSettingsShortcut)}`}
          aria-label={`${t("titlebar.settings")} ${formatShortcut(openSettingsShortcut)}`}
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
          title={panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show")}
          aria-label={panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show")}
          aria-pressed={panelVisible}
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
