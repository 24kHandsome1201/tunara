import { useEffect } from "react";
import { type Session, type RunState, deriveTitle } from "./types";
import { AGENT_ICONS, AGENT_CIRCLE_STYLES } from "./agents";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";

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
        animation: runState === "running" && !isAgent ? "pulseDot 1.3s ease-in-out infinite" : undefined,
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

function StatusMark({ runState, isAgent }: { runState: RunState; isAgent: boolean }) {
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
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-error)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
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
        background: "color-mix(in srgb, var(--c-accent) 14%, transparent)",
      }}
    >
      <span
        style={{
          display: "block",
          width: "42%",
          height: "100%",
          borderRadius: 999,
          background: "var(--c-accent)",
          animation: "agentBusyProgress 1.25s ease-in-out infinite",
        }}
      />
    </div>
  );
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0, marginLeft: "auto" }}>
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
  onClick: () => void;
  onClose?: () => void;
  onClearCloseConfirm?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function SessionCard({ session, active, confirmClose, onClick, onClose, onClearCloseConfirm, onContextMenu }: SessionCardProps) {
  const { primary, isCommand } = deriveTitle(session);
  const displayRunState = sessionDisplayRunState(session);
  const busy = isSessionBusy(session);
  const showBusyProgress = !!session.agent && busy;

  const handleClose = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (!onClose) return;
    onClose();
  };

  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => onClearCloseConfirm?.(), 3_000);
    return () => clearTimeout(timer);
  }, [confirmClose, onClearCloseConfirm]);

  useEffect(() => {
    if (confirmClose && !busy) onClearCloseConfirm?.();
  }, [busy, confirmClose, onClearCloseConfirm]);

  const totalAdded = session.changes?.files.reduce((a, f) => a + f.added, 0) ?? 0;
  const totalRemoved = session.changes?.files.reduce((a, f) => a + f.removed, 0) ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      onContextMenu={onContextMenu}
      className="session-card"
      style={{
        position: "relative",
        padding: "7px 10px 7px 12px",
        borderRadius: "var(--r-btn)",
        cursor: "pointer",
        userSelect: "none",
        background: active ? "var(--c-accent-bg-light)" : "transparent",
        border: "none",
        boxShadow: "none",
        outline: "none",
        transition: "background var(--duration-fast) ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "50%",
          transform: "translateY(-50%)",
          width: 3,
          height: active ? "60%" : "0%",
          minHeight: active ? 18 : 0,
          background: "var(--c-accent)",
          borderRadius: "0 2px 2px 0",
          opacity: active ? 1 : 0,
          transition: "height var(--duration-normal) ease, min-height var(--duration-normal) ease, opacity var(--duration-fast) ease",
        }}
      />

      {session.unread && (
        <span
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: displayRunState === "failed" ? "var(--c-error)" : "var(--c-accent)",
          }}
        />
      )}

      {onClose && (
        <span
          role="button"
          tabIndex={0}
          title={confirmClose ? "再次点击确认关闭" : "关闭"}
          onClick={handleClose}
          onKeyDown={(e) => { if (e.key === "Enter") handleClose(e); }}
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
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SessionIcon session={session} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 行1: 状态标记 + 标题 */}
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <StatusMark runState={displayRunState} isAgent={!!session.agent} />
            <span
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
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }}>
              {session.dir.split("/").pop() || session.dir}
            </span>
            {session.branch && (
              <>
                <span style={{ flexShrink: 0 }}>·</span>
                <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>⎇ {session.branch}</span>
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

      {showBusyProgress && <BusyProgress />}
    </div>
  );
}
