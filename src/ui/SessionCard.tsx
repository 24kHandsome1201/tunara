import { useEffect, useState, useRef, useCallback } from "react";
import { type Session, type RunState, type TerminalProgress, deriveTitle } from "./types";
import { AGENT_ICONS, AGENT_CIRCLE_STYLES } from "./agents";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";
import { useSessionsStore } from "@/state/sessions";
import { CloseIcon } from "./shared";

function StatusDot({ runState, unread, isAgent }: { runState: RunState; unread?: boolean; isAgent: boolean }) {
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
        animation: runState === "running" && !isAgent ? "pulseDot 1.5s var(--ease-in-out) infinite" : "scaleIn var(--duration-fast) var(--ease-out-back)",
        boxShadow: runState === "running" ? `0 0 6px ${color}` : undefined,
      }}
    />
  );
}

function SessionIcon({ session }: { session: Session }) {
  const size = 24;
  const displayRunState = sessionDisplayRunState(session);

  if (session.agent) {
    const style = AGENT_CIRCLE_STYLES[session.agent] ?? AGENT_CIRCLE_STYLES.CC;
    const Icon = AGENT_ICONS[session.agent];
    return (
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: style.bg,
            color: style.color,
            border: `1px solid ${style.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {Icon ? <Icon size={size} /> : (
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {session.agent.charAt(0)}
            </span>
          )}
        </div>
        <StatusDot runState={displayRunState} unread={session.unread} isAgent />
      </div>
    );
  }

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
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
      <StatusDot runState={displayRunState} unread={session.unread} isAgent={false} />
    </div>
  );
}

function StatusMark({ runState, isAgent, exitCode }: { runState: RunState; isAgent: boolean; exitCode?: number }) {
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
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-accent)", animation: isAgent ? undefined : "pulseDot 1.2s ease infinite" }} />
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
        borderRadius: 3,
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
        borderRadius: 999,
        background: "color-mix(in srgb, var(--c-accent) 10%, transparent)",
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
      }}
    >
      <span
        style={{
          display: "block",
          width: "38%",
          height: "100%",
          borderRadius: 999,
          background: "linear-gradient(90deg, transparent, var(--c-accent), transparent)",
          animation: "agentBusyProgress 1.6s var(--ease-in-out) infinite",
        }}
      />
    </div>
  );
}

function TerminalProgressBar({ progress }: { progress: TerminalProgress }) {
  const color = progress.state === "error"
    ? "var(--c-error)"
    : progress.state === "warning"
      ? "var(--c-warning)"
      : "var(--c-accent)";
  const indeterminate = progress.state === "indeterminate";
  const hasValue = progress.value !== undefined;
  const width = indeterminate ? "38%" : hasValue ? `${progress.value}%` : "100%";
  const statusLabel = progress.state === "error"
    ? "终端任务错误"
    : progress.state === "warning"
      ? "终端任务警告"
      : "终端任务进行中";
  const progressLabel = hasValue ? `终端任务进度 ${progress.value}%` : statusLabel;
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
        <span style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--c-diff-add-text)", background: "var(--c-diff-add-bg)", borderRadius: 4, padding: "1px 5px" }}>
          +{added}
        </span>
      )}
      {removed > 0 && (
        <span style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--c-diff-del-text)", background: "var(--c-diff-del-bg)", borderRadius: 4, padding: "1px 5px" }}>
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
  confirmClose?: boolean;
  tabIndex?: number;
  onClick: () => void;
  onClose?: () => void;
  onRename?: (name: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function SessionCard({ session, active, confirmClose, tabIndex, onClick, onClose, onRename, onKeyDown, onContextMenu }: SessionCardProps) {
  const { primary, isCommand, totalAdded, totalRemoved } = deriveTitle(session);
  const displayRunState = sessionDisplayRunState(session);
  const busy = isSessionBusy(session);
  const showTerminalProgress = !!session.terminalProgress;
  const showBusyProgress = !!session.agent && busy && !showTerminalProgress;
  const elapsed = useElapsed(session.startedAt, busy);
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
      onRename?.(trimmed);
    } else if (!trimmed) {
      onRename?.("");
    }
    setEditing(false);
    useSessionsStore.getState().stopRenaming();
  }, [editValue, primary, onRename]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const handleClose = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (!onClose) return;
    onClose();
  };

  return (
    <div
      role="button"
      tabIndex={tabIndex ?? 0}
      aria-current={active ? "page" : undefined}
      data-session-card-id={session.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
          return;
        }
        if ((e.key === "Delete" || e.key === "Backspace") && onClose) {
          e.preventDefault();
          onClose();
          return;
        }
        onKeyDown?.(e);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onContextMenu={onContextMenu}
      className="session-card"
      style={{
        position: "relative",
        padding: "6px 10px 6px 12px",
        borderRadius: "var(--r-btn)",
        // cursor 由外层 wrapper 控制（grab / grabbing / pointer），允许 inherit
        userSelect: "none",
        background: active ? "var(--c-accent-bg-light)" : "transparent",
        border: "none",
        outline: focused ? "2px solid color-mix(in srgb, var(--c-accent) 75%, transparent)" : "none",
        outlineOffset: focused ? "-1px" : 0,
        transition: "background var(--duration-fast) ease, outline-color var(--duration-fast) var(--ease-smooth)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "50%",
          transform: "translateY(-50%)",
          width: 2,
          height: 18,
          background: "var(--c-accent)",
          borderRadius: "0 2px 2px 0",
          opacity: active ? 1 : 0,
          transition: "opacity var(--duration-fast) ease",
        }}
      />

      {onClose && (
        <span
          aria-hidden="true"
          title={confirmClose ? "再次点击确认关闭" : "关闭（Delete）"}
          onClick={handleClose}
          className="session-card-close hover-close"
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 18,
            height: 18,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: confirmClose ? "var(--c-error)" : "var(--c-text-5)",
            cursor: "pointer",
            zIndex: 2,
          }}
        >
          <CloseIcon size={11} strokeWidth={2.5} />
        </span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SessionIcon session={session} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 行1: 状态标记 + 标题 */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <StatusMark runState={displayRunState} isAgent={!!session.agent} exitCode={session.lastExitCode} />
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
                aria-label="SSH"
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
        <div
          style={{
            marginTop: 6,
            fontSize: "var(--fs-meta)",
            color: "var(--c-error)",
            lineHeight: 1.3,
          }}
        >
          进程运行中，再次点击关闭
        </div>
      )}

      {session.terminalProgress && <TerminalProgressBar progress={session.terminalProgress} />}
      {showBusyProgress && <BusyProgress />}
    </div>
  );
}
