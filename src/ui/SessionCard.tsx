import { memo, useEffect, useState, useRef, useCallback } from "react";
import { type Session, type TerminalProgress, deriveTitle } from "./types";
import { getAgentCircleStyle, getAgentIcon } from "./agents";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";
import { sessionCue } from "@/modules/session/session-attention";
import { sidebarCwdLabel, sshCardConnectionPhase, sshConnectionPhaseTone, sshEndpointLabel } from "@/modules/session/sidebar-groups";
import { SessionCueDot } from "./SessionCueDot";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { formatShortcut } from "./formatShortcut";
import { CloseIcon } from "./shared";
import { Icon, Terminal } from "@/ui/icons";
import { useDestructiveConfirmCountdown } from "./lib/destructive-confirm";
import { formatElapsed } from "./lib/elapsed";
import { useContextMenuTrigger } from "./overlays/context-menu-trigger";
import { isFixedTerminalMenuEvent } from "@/modules/config/keybindings";

function SessionIcon({ session }: { session: Session }) {
  const size = 24;
  const cue = sessionCue(session);

  if (session.agent) {
    const style = getAgentCircleStyle(session.agent);
    const Icon = getAgentIcon(session.agent);
    return (
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "var(--r-badge)",
            background: style.bg,
            color: style.color,
            border: `1px solid ${style.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {Icon ? <Icon size={size} /> : (
            <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {session.agent.charAt(0)}
            </span>
          )}
        </div>
        <SessionCueDot cue={cue} overlay runState={sessionDisplayRunState(session)} />
      </div>
    );
  }

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "var(--r-badge)",
          background: "var(--c-bg-3)",
          color: "var(--c-text-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon icon={Terminal} size={12} weight="bold" />
      </div>
      <SessionCueDot cue={cue} overlay runState={sessionDisplayRunState(session)} />
    </div>
  );
}

function BusyProgress() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 10,
        right: 10,
        bottom: 0,
        height: 2,
        overflow: "hidden",
        borderRadius: 1,
        background: "color-mix(in srgb, var(--c-accent) 14%, transparent)",
      }}
    >
      <span
        style={{
          display: "block",
          width: "38%",
          height: "100%",
          borderRadius: 1,
          background: "var(--c-accent)",
        }}
      />
    </div>
  );
}

function TerminalProgressBar({ progress }: { progress: TerminalProgress }) {
  const t = useT();
  const color = progress.state === "error"
    ? "var(--c-error)"
    : progress.state === "warning"
      ? "var(--c-warning)"
      : "var(--c-accent)";
  const indeterminate = progress.state === "indeterminate";
  const hasValue = progress.value !== undefined;
  const width = indeterminate ? "38%" : hasValue ? `${progress.value}%` : "100%";
  const statusLabel = progress.state === "error"
    ? t("session.progress.error")
    : progress.state === "warning"
      ? t("session.progress.warning")
      : t("session.progress.running");
  const progressLabel = hasValue ? t("session.progress.value", { value: progress.value! }) : statusLabel;
  return (
    <div
      aria-label={progressLabel}
      title={progressLabel}
      style={{
        position: "absolute",
        left: 10,
        right: 10,
        bottom: 0,
        height: 2,
        overflow: "hidden",
        borderRadius: 999,
        background: "color-mix(in srgb, var(--c-text-primary) 8%, transparent)",
      }}
    >
      <span
        style={{
          display: "block",
          width,
          minWidth: indeterminate ? undefined : 2,
          height: "100%",
          borderRadius: 999,
          background: color,
        }}
      />
    </div>
  );
}

function useElapsed(startedAt: number | undefined, active: boolean): string | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt || !active) return null;
  return formatElapsed(now - startedAt);
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0, marginLeft: "auto", paddingLeft: 6 }}>
      {added > 0 && (
        <span style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--c-diff-add-text)" }}>
          +{added}
        </span>
      )}
      {removed > 0 && (
        <span style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--c-diff-del-text)" }}>
          -{removed}
        </span>
      )}
    </span>
  );
}

// ── SessionCard 主组件 ──

interface SessionCardProps {
  session: Session;
  active: boolean;
  confirmCloseAt?: number;
  tabIndex?: number;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onRename?: (id: string, name: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>, id: string) => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
}

function SessionCardImpl({ session, active, confirmCloseAt = 0, tabIndex, onSelect, onClose, onRename, onKeyDown, onContextMenu }: SessionCardProps) {
  const confirmClose = confirmCloseAt > 0;
  // Subscribe to the language store: deriveTitle localizes the agent activity
  // suffix (· 运行中 / · Working), and this card is memoized.
  const t = useT();
  const closeSessionShortcut = useUIStore((s) => s.keybindings.closeSession);
  // Unsaved reader draft is user intent (like pinned), not agent state — it
  // sits beside the title, never in the single status-dot slot.
  const readerDirty = useUIStore((s) => s.readers[session.id]?.dirty === true);
  const closeLabel = `${t("session.close.title")} ${formatShortcut(closeSessionShortcut)}`;
  const { primary, isCommand, totalAdded, totalRemoved } = deriveTitle(session);
  const displayRunState = sessionDisplayRunState(session);
  const lifecycleLabel = session.agentActivity === "waiting_confirmation"
    ? t("agent.status.waiting_confirmation")
    : t(`sidebar.session.status.${displayRunState}`);
  const connectionPhase = sshCardConnectionPhase(session);
  const connectionTone = connectionPhase ? sshConnectionPhaseTone(connectionPhase) : null;
  const accessibleLabel = [
    primary,
    lifecycleLabel,
    connectionPhase ? t(`connection.phase.${connectionPhase}`) : "",
    session.unread ? t("sidebar.session.unread") : "",
    readerDirty ? t("sidebar.session.unsaved") : "",
    session.remote ? `${t("sidebar.session.remote")}, ${sshEndpointLabel(session.remote)}` : t("sidebar.session.local"),
  ].filter(Boolean).join(", ");
  const busy = isSessionBusy(session);
  const showTerminalProgress = !!session.terminalProgress;
  const showBusyProgress = !!session.agent && busy && !showTerminalProgress;
  const elapsed = useElapsed(session.startedAt, busy);
  const closeCountdown = useDestructiveConfirmCountdown(confirmClose ? confirmCloseAt : 0);
  const renamingSessionId = useSessionsStore((s) => s.renamingSessionId);
  const isRenaming = renamingSessionId === session.id;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const touchMenu = useContextMenuTrigger<HTMLButtonElement>({
    disabled: editing || !onContextMenu,
    onOpen: ({ x, y }) => {
      selectRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: x,
        clientY: y,
      }));
    },
  });

  useEffect(() => {
    if (isRenaming && !editing) {
      setEditValue(session.customTitle ?? primary);
      setEditing(true);
    }
  }, [isRenaming, editing, session.customTitle, primary]);

  const startRename = useCallback(() => {
    if (!onRename) return;
    setEditValue(session.customTitle ?? primary);
    setEditing(true);
  }, [onRename, session.customTitle, primary]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== primary) {
      onRename?.(session.id, trimmed);
    } else if (!trimmed) {
      onRename?.(session.id, "");
    }
    setEditing(false);
    useSessionsStore.getState().stopRenaming();
  }, [editValue, primary, onRename, session.id]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const handleClose = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (!onClose) return;
    onClose(session.id);
  };

  const handleClick = () => onSelect(session.id);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!editing && isFixedTerminalMenuEvent(e)) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
      return;
    }
    if (!editing && onRename && e.key === "F2") {
      e.preventDefault();
      startRename();
      return;
    }
    if (!editing && onRename && active && e.key === "Enter") {
      e.preventDefault();
      startRename();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(session.id);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && onClose) {
      e.preventDefault();
      onClose(session.id);
      return;
    }
    onKeyDown?.(e, session.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu?.(e, session);
  };

  return (
    <div
      data-session-card-id={session.id}
      onContextMenu={handleContextMenu}
      className="session-card"
      style={{
        position: "relative",
        padding: "7px 10px 7px 12px",
        borderRadius: "var(--r-card)",
        // cursor 由外层 wrapper 控制（grab / grabbing / pointer），允许 inherit
        userSelect: "none",
        background: "transparent",
        border: "1px solid transparent",
      }}
    >
      <div className="session-card-rail" aria-hidden="true" />

      {!editing && (
        <button
          ref={selectRef}
          type="button"
          tabIndex={tabIndex ?? 0}
          aria-current={active ? "page" : undefined}
          aria-label={accessibleLabel}
          onClick={handleClick}
          onClickCapture={touchMenu.onClickCapture}
          onPointerDown={touchMenu.onPointerDown}
          onPointerMove={touchMenu.onPointerMove}
          onPointerUp={touchMenu.onPointerUp}
          onPointerCancel={touchMenu.onPointerCancel}
          // The overlay button covers the whole card, so the title's own
          // dblclick never fires — rename must be triggered from here.
          onDoubleClick={onRename ? () => startRename() : undefined}
          onKeyDown={handleKeyDown}
          className="session-card-select"
          // cursor 继承外层 wrapper（grab / grabbing / pointer），不再固定 pointer 盖掉拖拽光标
          style={{ position: "absolute", inset: 0, zIndex: 1, padding: 0, border: "none", borderRadius: "var(--r-card)", background: "transparent", cursor: "inherit" }}
        />
      )}

      {onClose && (
        <button
          type="button"
          tabIndex={0}
          aria-label={confirmClose ? t("destructive.confirm_again.close") : closeLabel}
          title={confirmClose ? t("destructive.confirm_again.close") : closeLabel}
          onClick={handleClose}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              handleClose(e);
            }
          }}
          className="session-card-close hover-close"
          data-confirm={confirmClose ? "true" : undefined}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            borderRadius: "var(--r-badge-sm)",
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: confirmClose ? "var(--c-error)" : "var(--c-text-5)",
            cursor: "pointer",
            zIndex: 2,
            padding: 0,
          }}
        >
          <CloseIcon size={11} strokeWidth={2.5} />
        </button>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative", zIndex: 1, pointerEvents: editing ? "auto" : "none" }}>
        <SessionIcon session={session} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 行1: 标题；置顶是用户意图不是状态，视觉降到最低 */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {session.pinned && (
              <span title={t("sidebar.session.pinned")} aria-label={t("sidebar.session.pinned")} style={{ color: "var(--c-text-6)", fontSize: "var(--fs-meta)", flexShrink: 0, opacity: 0.7 }}>★</span>
            )}
            {editing ? (
              <input
                className="ui-native-control"
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setEditValue(session.customTitle ?? primary);
                    setEditing(false);
                    useSessionsStore.getState().stopRenaming();
                  }
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: "var(--fs-body)",
                  fontWeight: 600,
                  color: "var(--c-text-primary)",
                  fontFamily: "var(--font-ui)",
                  lineHeight: 1.3,
                  border: "1px solid var(--c-control-border)",
                  outline: "2px solid var(--c-accent)",
                  outlineOffset: 1,
                  background: "var(--c-bg-3)",
                  borderRadius: "var(--r-badge-sm)",
                  padding: "0 4px",
                  width: "100%",
                  minWidth: 0,
                }}
              />
            ) : (
              <span
                onDoubleClick={(e) => { e.stopPropagation(); startRename(); }}
                style={{
                  fontSize: "var(--fs-body)",
                  fontWeight: session.unread ? 700 : 600,
                  color: "var(--c-text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: isCommand ? "var(--font-mono)" : "var(--font-ui)",
                  lineHeight: 1.3,
                }}
              >
                {primary}
              </span>
            )}
            {readerDirty && (
              <span
                title={t("sidebar.session.unsaved")}
                aria-label={t("sidebar.session.unsaved")}
                style={{ color: "var(--c-text-6)", fontSize: "var(--fs-meta)", flexShrink: 0, opacity: 0.85, fontFamily: "var(--font-mono)" }}
              >
                ●
              </span>
            )}
            {connectionPhase && connectionTone && (
              <span
                style={{
                  flexShrink: 0,
                  borderRadius: "var(--r-badge-sm)",
                  padding: "0 5px",
                  fontSize: "var(--fs-meta)",
                  fontWeight: 700,
                  lineHeight: "16px",
                  color: connectionTone === "error"
                    ? "var(--c-error)"
                    : connectionTone === "warning"
                      ? "var(--c-warning-text)"
                      : "var(--c-accent)",
                  background: connectionTone === "error"
                    ? "var(--c-error-bg)"
                    : connectionTone === "warning"
                      ? "var(--c-warning-bg)"
                      : "color-mix(in srgb, var(--c-accent) 14%, transparent)",
                }}
              >
                {t(`connection.phase.${connectionPhase}`)}
              </span>
            )}
          </div>

          {/* 行2: 目录 · 分支 · diff */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginTop: 2,
              lineHeight: 1.3,
              fontSize: "var(--fs-meta)",
              fontFamily: "var(--font-mono)",
              color: "var(--c-text-5)",
              overflow: "hidden",
            }}
          >
            {session.remote && (
              // Remote marker: host identity lives on the group header; this
              // glyph plus tooltip still distinguish transport on the card.
              <span
                title={sshEndpointLabel(session.remote)}
                style={{ flexShrink: 0, color: "var(--c-accent)", fontSize: "var(--fs-meta)" }}
                aria-hidden="true"
              >
                ⇄
              </span>
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 48%", minWidth: 0 }}>
              {sidebarCwdLabel(session)}
            </span>
            {session.branch && (
              <>
                <span style={{ flexShrink: 0 }}>·</span>
                <span title={session.branch} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "0 1 auto", minWidth: 0, maxWidth: "42%" }}>⎇ {session.branch}</span>
              </>
            )}
            {elapsed && (
              <>
                <span style={{ flexShrink: 0 }}>·</span>
                <span style={{ flexShrink: 0, whiteSpace: "nowrap", color: "var(--c-accent)" }}>{elapsed}</span>
              </>
            )}
            <DiffStat added={totalAdded} removed={totalRemoved} />
          </div>
        </div>
      </div>

      {confirmClose && (
        <div style={{ marginTop: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontSize: "var(--fs-meta)",
              color: "var(--c-error)",
              lineHeight: 1.3,
            }}
          >
            <span style={{ minWidth: 0 }}>{t("session.close.running_hint")}</span>
            {closeCountdown && (
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {closeCountdown.remainingSeconds}s
              </span>
            )}
          </div>
          {closeCountdown && (
            <div
              aria-hidden="true"
              style={{
                marginTop: 4,
                height: 2,
                borderRadius: 999,
                overflow: "hidden",
                background: "color-mix(in srgb, var(--c-error) 12%, transparent)",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: `${closeCountdown.progress * 100}%`,
                  height: "100%",
                  borderRadius: 999,
                  background: "var(--c-error)",
                  transition: "width var(--dur-fast) var(--ease-out)",
                }}
              />
            </div>
          )}
        </div>
      )}

      {session.terminalProgress && <TerminalProgressBar progress={session.terminalProgress} />}
      {showBusyProgress && <BusyProgress />}
    </div>
  );
}

// Memoized: callbacks are generic (take sessionId), so their identity is
// stable across Sidebar re-renders. A card only re-renders when its own
// data props (session/active/confirmCloseAt/tabIndex) actually change.
export const SessionCard = memo(SessionCardImpl);
