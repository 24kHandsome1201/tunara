import { memo, useMemo, useRef, useState } from "react";
import { type Session } from "./types";
import { useUIStore } from "@/state/ui";
import { formatShortcut } from "./formatShortcut";
import { platform } from "@tauri-apps/plugin-os";
import { useT } from "@/modules/i18n";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { Icon, Minus, Plus, SidebarSimple, Square, X } from "@/ui/icons";
import {
  groupSessionsForSidebar,
  representativeSession,
  sidebarGroupKey,
  titlebarDeviceCaption,
} from "@/modules/session/sidebar-groups";
import type { ConnectionPhase } from "@/modules/terminal/lib/connection-state";

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
  onNewTerminalInDirectory: () => void;
  onOpenSettings: () => void;
}

function PanelLeftIcon({ active }: { active: boolean }) {
  return (
    <Icon
      icon={SidebarSimple}
      size={16}
      style={{ ...TITLEBAR_ICON_STYLE, color: active ? "var(--c-accent)" : "currentColor" }}
    />
  );
}

function deviceConnectionColor(phase: ConnectionPhase | null): string {
  if (phase === "ready") return "var(--c-success)";
  if (phase === "failed" || phase === "disconnected" || phase === "exited") return "var(--c-error)";
  if (phase === "needsUserAction" || phase === "verifyingHostKey") return "var(--c-warning)";
  return phase ? "var(--c-accent)" : "var(--c-text-7)";
}

function DeviceIdentityContent({
  label,
  kind,
  connectionPhase,
}: {
  label: string;
  kind: "local" | "ssh" | null;
  connectionPhase: ConnectionPhase | null;
}) {
  return (
    <>
      {kind === "ssh" && (
        <span
          aria-hidden="true"
          data-titlebar-connection-phase={connectionPhase ?? "unknown"}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: deviceConnectionColor(connectionPhase),
            flexShrink: 0,
          }}
        />
      )}
      <span style={{
        fontSize: "var(--fs-secondary)",
        fontWeight: 600,
        color: "var(--c-text-primary)",
        fontFamily: "var(--font-ui)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {label}
      </span>
    </>
  );
}

function WindowControls() {
  const t = useT();
  const win = tryGetCurrentWindow();
  if (!win) return null;
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
        <Icon icon={Minus} size={12} weight="bold" />
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={t("titlebar.window.maximize")}
        className="hover-bg"
        style={btnBase}
      >
        <Icon icon={Square} size={11} />
      </button>
      <button
        onClick={() => win.close()}
        title={t("titlebar.window.close")}
        className="hover-close"
        style={btnBase}
      >
        <Icon icon={X} size={12} weight="bold" />
      </button>
    </div>
  );
}

function TitlebarImpl({
  sessions,
  activeSessionId,
  panelVisible,
  sidebarVisible,
  onToggleSidebar,
  onTogglePanel,
  onSelectSession: _onSelectSession,
  onCloseSession: _onCloseSession,
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSettings,
}: TitlebarProps) {
  const t = useT();
  const deviceCaption = useMemo(() => {
    const groups = groupSessionsForSidebar(sessions);
    const active = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
    const group = active
      ? groups.find((candidate) => candidate.key === sidebarGroupKey(active)) ?? null
      : null;
    if (!group) return null;
    const { label, detail } = titlebarDeviceCaption(group);
    const currentSession = representativeSession(group.sessions, activeSessionId);
    return {
      key: group.key,
      kind: group.kind,
      label,
      detail,
      connectionPhase: group.kind === "ssh" ? currentSession?.connection?.phase ?? null : null,
    };
  }, [sessions, activeSessionId]);
  const trafficLightWidth = useUIStore((s) => s.trafficLightWidth);
  const newTerminalShortcut = useUIStore((s) => s.keybindings.newTerminal);
  const [newTerminalMenu, setNewTerminalMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const workspaceMenuBtnRef = useRef<HTMLButtonElement>(null);

  const openNewTerminalMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setNewTerminalMenu({
      position: event.type === "contextmenu"
        ? { x: event.clientX, y: event.clientY }
        : { x: rect.left, y: rect.bottom },
      items: [
        { id: "new-terminal", label: t("titlebar.new_terminal"), icon: "terminal", action: onNewTerminal },
        { id: "new-terminal-directory", label: t("titlebar.new_terminal_in_directory"), icon: "folder", action: onNewTerminalInDirectory },
        null,
        { id: "new-ssh-session", label: t("titlebar.new_ssh_session"), icon: "ssh", action: () => useUIStore.getState().openSshConnect() },
      ],
    });
  };

  const openWorkspaceMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setWorkspaceMenu({
      position: { x: rect.right, y: rect.bottom },
      items: [
        { id: "toggle-panel", label: panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show"), action: onTogglePanel },
        { id: "settings", label: t("titlebar.settings"), action: onOpenSettings },
      ],
    });
  };

  const titlebarControlTransform = _isMac ? `translateY(${MAC_TITLEBAR_CONTROL_Y_OFFSET}px)` : undefined;
  const deviceConnectionLabel = deviceCaption?.connectionPhase
    ? t(`connection.phase.${deviceCaption.connectionPhase}`)
    : "";
  const deviceAccessibleName = deviceCaption
    ? [
        deviceCaption.kind === "ssh"
          ? `${deviceCaption.label}, ${t("workspace.ssh")}`
          : deviceCaption.label,
        deviceConnectionLabel,
      ].filter(Boolean).join(", ")
    : "";
  const deviceTitle = deviceCaption
    ? [deviceCaption.detail || deviceCaption.label, deviceConnectionLabel].filter(Boolean).join(" · ")
    : "";
  const deviceIdentityStyle = {
    height: "var(--h-titlebar-control)",
    maxWidth: "min(280px, 36vw)",
    padding: "0 8px",
    marginLeft: 2,
    borderRadius: "var(--r-btn)",
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
    transform: titlebarControlTransform,
  } satisfies React.CSSProperties;

  return (
    <div
      className="tunara-titlebar"
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
        {sessions.length > 0 && (
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
        )}
      </div>

      {deviceCaption && (
        <div
          role="status"
          data-titlebar-device={deviceCaption.key}
          data-titlebar-device-kind={deviceCaption.kind}
          title={deviceTitle}
          aria-label={deviceAccessibleName}
          style={{ ...deviceIdentityStyle, WebkitAppRegion: "drag" } as DragStyle}
        >
          <DeviceIdentityContent
            label={deviceCaption.label}
            kind={deviceCaption.kind}
            connectionPhase={deviceCaption.connectionPhase}
          />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", alignItems: "center", paddingLeft: 4, transform: titlebarControlTransform, WebkitAppRegion: "no-drag" } as DragStyle}>
        <button
          onClick={openNewTerminalMenu}
          onContextMenu={openNewTerminalMenu}
          title={`${t("titlebar.new_menu")} · ${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
          aria-label={t("titlebar.new_menu")}
          aria-haspopup="menu"
          aria-expanded={Boolean(newTerminalMenu)}
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
          <Icon icon={Plus} size={13} weight="bold" />
        </button>
      </div>

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
          ref={workspaceMenuBtnRef}
          type="button"
          onClick={openWorkspaceMenu}
          title={t("common.more_actions")}
          aria-label={t("common.more_actions")}
          aria-haspopup="menu"
          aria-expanded={workspaceMenu !== null}
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
          <span aria-hidden="true" style={{ fontSize: 14, letterSpacing: -1 }}>•••</span>
        </button>

        {!_isMac && <WindowControls />}
      </div>
      {newTerminalMenu && (
        <ContextMenu
          items={newTerminalMenu.items}
          position={newTerminalMenu.position}
          onClose={() => setNewTerminalMenu(null)}
        />
      )}
      {workspaceMenu && (
        <ContextMenu
          items={workspaceMenu.items}
          position={workspaceMenu.position}
          onClose={() => setWorkspaceMenu(null)}
          returnFocusToken={workspaceMenuBtnRef}
        />
      )}
    </div>
  );
}

// Memoized: props are store primitives + module-level/useCallback-stable
// callbacks from App, so dragging the sidebar width no longer re-renders
// the titlebar (and its tabs) on every pointer frame.
export const Titlebar = memo(TitlebarImpl);
