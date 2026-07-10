import { memo, useEffect, useState, useRef, useCallback } from "react";
import { type Session, type RunState, type TerminalProgress, deriveTitle } from "./types";
import { getAgentCircleStyle, getAgentIcon } from "./agents";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { formatShortcut } from "./formatShortcut";
import { CloseIcon } from "./shared";
import { useDestructiveConfirmCountdown } from "./lib/destructive-confirm";
import { SessionMascotIcon } from "./SessionMascotIcon";

function StatusDot({ runState, unread }: { runState: RunState; unread?: boolean }) {
  const showDone = (runState === "done" || runState === "failed") && unread;
  if (runState === "idle" || ((runState === "done" || runState === "failed") && !unread)) return null;
  const color = runState === "running"
    ? "var(--c-accent)"
    : showDone && runState === "done"
      ? "var(--c-success)"
      : "var(--c-error)";
  return (
    <span
      style={{
        position: "absolute",
        bottom: -1,
        right: -1,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        border: "2px solid var(--c-bg-white)",
        animation: "scaleIn var(--duration-fast) var(--ease-out-expo)",
      }}
    />
  );
}

function SessionIcon({ session }: { session: Session }) {
  const size = 24;
  const displayRunState = sessionDisplayRunState(session);

  if (session.mascot) {
    return (
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "var(--r-badge)",
            background: "var(--c-bg-3)",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
          }}
        >
          <SessionMascotIcon id={session.mascot} size={23} />
        </div>
        <StatusDot runState={displayRunState} unread={session.unread} />
      </div>
    );
  }

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
        <StatusDot runState={displayRunState} unread={session.unread} />
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
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>
      <StatusDot runState={displayRunState} unread={session.unread} />
    </div>
  );
}

function StatusMark({ runState, exitCode }: { runState: RunState; exitCode?: number }) {
  if (runState === "done") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (runState === "running") {
    return (
      <span style={{ width: 13, height: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-accent)" }} />
      </span>
    );
  }
  if (runState === "failed") {
    return <CloseIcon size={13} strokeWidth={2.8} color="var(--c-error)" />;
  }
  if (runState === "idle" && exitCode !== undefined && exitCode !== 0) {
    return (
      <span style={{
        fontSize: "var(--fs-badge)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: "var(--c-error)",
        background: "var(--c-error-bg)",
        borderRadius: "var(--r-badge-sm)",
        padding: "0 3px",
        lineHeight: "14px",
        flexShrink: 0,
      }}>
        {exitCode}
      </span>
    );
  }
  return null;
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
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
      }}
    >
      <span
        style={{
          display: "block",
          width: "38%",
          height: "100%",
          borderRadius: 1,
          background: "var(--c-accent)",
          animation: "agentBusyProgress 1.6s var(--ease-in-out) infinite",
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
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
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
          animation: indeterminate ? "indeterminate 1.2s var(--ease-in-out) infinite" : undefined,
        }}
      />
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>, id: string) => void;
  onContextMenu?: (e: React.MouseEvent, session: Session) => void;
}

function SessionCardImpl({ session, active, confirmCloseAt = 0, tabIndex, onSelect, onClose, onRename, onKeyDown, onContextMenu }: SessionCardProps) {
  const confirmClose = confirmCloseAt > 0;
  // Subscribe to the language store: deriveTitle localizes the agent activity
  // suffix (· 运行中 / · Working), and this card is memoized.
  const t = useT();
  const closeSessionShortcut = useUIStore((s) => s.keybindings.closeSession);
  const closeLabel = `${t("session.close.title")} ${formatShortcut(closeSessionShortcut)}`;
  const { primary, isCommand, totalAdded, totalRemoved } = deriveTitle(session);
  const displayRunState = sessionDisplayRunState(session);
  const busy = isSessionBusy(session);
  const showTerminalProgress = !!session.terminalProgress;
  const showBusyProgress = !!session.agent && busy && !showTerminalProgress;
  const elapsed = useElapsed(session.startedAt, busy);
  const closeCountdown = useDestructiveConfirmCountdown(confirmClose ? confirmCloseAt : 0);
  const renamingSessionId = useSessionsStore((s) => s.renamingSessionId);
  const isRenaming = renamingSessionId === session.id;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
      role="button"
      tabIndex={tabIndex ?? 0}
      aria-current={active ? "page" : undefined}
      data-session-card-id={session.id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContextMenu={handleContextMenu}
      className="session-card"
      style={{
        position: "relative",
        padding: "6px 10px 6px 12px",
        borderRadius: "var(--r-card)",
        // cursor 由外层 wrapper 控制（grab / grabbing / pointer），允许 inherit
        userSelect: "none",
        background: active ? "var(--c-bg-white)" : "transparent",
        border: active ? "1px solid var(--c-border-1)" : "1px solid transparent",
        outline: focused ? "2px solid color-mix(in srgb, var(--c-accent) 70%, transparent)" : "none",
        outlineOffset: focused ? "-1px" : 0,
        transition: "background var(--duration-fast) ease, border-color var(--duration-fast) ease, outline-color var(--duration-fast) var(--ease-smooth)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "50%",
          transform: "translateY(-50%)",
          width: 1,
          height: 24,
          background: "var(--c-accent)",
          borderRadius: "0 1px 1px 0",
          opacity: active ? 1 : 0,
          transition: "opacity var(--duration-fast) ease",
        }}
      />

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
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 18,
            height: 18,
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

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SessionIcon session={session} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 行1: 状态标记 + 标题 */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <StatusMark runState={displayRunState} exitCode={session.lastExitCode} />
            {session.pinned && (
              <span title={t("sidebar.session.pinned")} aria-label={t("sidebar.session.pinned")} style={{ color: "var(--c-accent)", fontSize: "var(--fs-meta)", flexShrink: 0 }}>★</span>
            )}
            {session.note && (
              <span title={t("sidebar.session.has_note")} aria-label={t("sidebar.session.has_note")} style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)", flexShrink: 0 }}>✎</span>
            )}
            {editing ? (
              <input
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
                  border: "none",
                  outline: "none",
                  background: "var(--c-bg-3)",
                  borderRadius: 4,
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
              // Remote (SSH) marker: a small plug glyph so local vs. remote
              // sessions are distinguishable at a glance. session.dir already
              // shows user@host for remote sessions.
              <span
                title={`${session.remote.user}@${session.remote.host}${session.remote.port !== 22 ? `:${session.remote.port}` : ""}`}
                style={{ flexShrink: 0, color: "var(--c-accent)", fontSize: "var(--fs-meta)" }}
                aria-label={t("sidebar.session.remote")}
              >
                ⇄
              </span>
            )}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }}>
              {session.remote ? session.dir : session.dir.split("/").pop() || session.dir}
            </span>
            {session.branch && (
              <>
                <span style={{ flexShrink: 0 }}>·</span>
                <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>⎇ {session.branch}</span>
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
                  transition: "width 100ms linear",
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
