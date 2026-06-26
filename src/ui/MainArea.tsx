import { memo, useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalView";
import type { Session } from "./types";
import { gitAheadBehind, gitStatus, type RemoteState } from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SplitHandle } from "./SplitHandle";
import { AgentStatusBar } from "./AgentStatusBar";

// Stable, module-level callback: clearing pendingInput only needs the session
// id, so it never needs to close over render scope. Passing a fresh arrow per
// render would defeat TerminalView's memo.
function clearPendingInput(id: string) {
  useSessionsStore.getState().updateSession(id, { pendingInput: undefined, pendingInputSubmit: undefined });
}

// One mounted terminal pane. Memoized and given only primitive props so it
// re-renders solely when its own session's pendingInput/active state changes —
// not on every agent heartbeat that re-renders MainArea.
const TerminalPane = memo(function TerminalPane({
  session,
  isActive,
}: {
  session: Session;
  isActive: boolean;
}) {
  return (
    <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <AgentStatusBar session={session} />
      <TerminalView
        sessionId={session.id}
        dir={session.dir}
        active={isActive}
        pendingInput={session.pendingInput}
        pendingInputSubmit={session.pendingInputSubmit}
        onPendingInputConsumed={clearPendingInput}
      />
    </div>
  );
});

interface MainAreaProps {
  sessions: Session[];
  activeSessionId: string;
}

function SplitIcon({ direction }: { direction: "columns" | "rows" | "single" }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.35,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (direction === "rows") {
    return (
      <svg {...common}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        <path d="M1.5 8h13" />
        <path d="M3.5 3.5h9v3h-9Z" fill="currentColor" opacity="0.16" stroke="none" />
      </svg>
    );
  }

  if (direction === "columns") {
    return (
      <svg {...common}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        <path d="M8 1.5v13" />
        <path d="M3.5 3.5h3v9h-3Z" fill="currentColor" opacity="0.16" stroke="none" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M5 5l6 6M11 5l-6 6" />
    </svg>
  );
}

export function MainArea({ sessions, activeSessionId }: MainAreaProps) {
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const nonce = useSessionsStore((s) => s.gitNonce[active?.id ?? ""] ?? 0);
  const launchedSessionIds = useSessionsStore((s) => s.launchedSessionIds);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const split = useUIStore((s) => s.split);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const paneASession =
    split.mode !== "single" && split.paneA
      ? sessions.find((s) => s.id === split.paneA)
      : null;
  const paneBSession = split.paneB ? sessions.find((s) => s.id === split.paneB) : null;

  useEffect(() => {
    if (!active?.dir) return;
    let cancelled = false;
    setRemote(null);
    gitAheadBehind(active.dir)
      .then((r) => !cancelled && setRemote(r))
      .catch(() => !cancelled && setRemote(null));
    gitStatus(active.dir)
      .then((status) => {
        if (cancelled) return;
        useSessionsStore.getState().updateSession(active.id, {
          branch: status.branch,
          gitState: "repo",
          changes: { files: status.files, summary: status.summary },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setRemote(null);
          useSessionsStore.getState().updateSession(active.id, {
            branch: "",
            gitState: "notGit",
            changes: undefined,
          });
        }
      });
    return () => { cancelled = true; };
  }, [active?.dir, active?.id, nonce]);

  function compactPath(path: string): string {
    if (path.length <= 48) return path;
    const normalized = path.replace(/^\/Users\/[^/]+/, "~");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 3) return normalized;
    return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
  }

  const isSplit = split.mode !== "single" && paneASession && paneBSession && paneASession.id !== paneBSession.id;
  const isHorizontal = split.mode === "horizontal";

  const mountedIdsForRender = new Set(Object.keys(launchedSessionIds));
  const mountedSessions = sessions.filter((s) => mountedIdsForRender.has(s.id));

  // Every mounted session keeps a stable, keyed wrapper across single<->split
  // transitions so React never unmounts its TerminalView (which would close the
  // PTY and kill any running agent). Layout is driven entirely by CSS here.
  function paneWrapperStyle(s: Session): React.CSSProperties {
    const isPaneA = isSplit && s.id === paneASession!.id;
    const isPaneB = isSplit && s.id === paneBSession!.id;

    if (isPaneA || isPaneB) {
      const ratioPct = isPaneA ? split.ratio : 1 - split.ratio;
      const activeMarker = isHorizontal
        ? "inset 2px 0 0 var(--c-accent)"
        : "inset 0 2px 0 var(--c-accent)";
      return {
        [isHorizontal ? "width" : "height"]: `calc(${ratioPct * 100}% - 2.5px)`,
        order: isPaneA ? 0 : 2,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        borderRadius: 6,
        boxShadow: s.id === activeSessionId ? activeMarker : "none",
        transition: "box-shadow var(--duration-normal) var(--ease-smooth)",
      };
    }

    if (!isSplit && s.id === activeSessionId) {
      return {
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      };
    }

    return { display: "none" };
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--c-bg-white)", overflow: "hidden", minWidth: 0 }}>
      <div ref={splitContainerRef} style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: isSplit ? (isHorizontal ? "row" : "column") : "row" }}>
        {mountedSessions.map((s) => (
          <div
            key={s.id}
            onClick={() => {
              if (s.id !== activeSessionId) useSessionsStore.getState().setActive(s.id);
            }}
            style={paneWrapperStyle(s)}
          >
            <TerminalPane session={s} isActive={s.id === activeSessionId} />
          </div>
        ))}
        {isSplit && (
          <SplitHandle
            mode={split.mode as "horizontal" | "vertical"}
            containerRef={splitContainerRef}
            order={1}
          />
        )}
      </div>

      <div
        style={{
          height: "var(--h-statusbar)",
          background: "var(--c-bg-1)",
          borderTop: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 10,
          flexShrink: 0,
        }}
      >
        {/* 路径区 */}
        <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-shell-path)", fontFamily: "var(--font-mono)", fontWeight: 500, flex: "0 1 auto", minWidth: 48, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={active?.dir ?? ""}>
          {compactPath(active?.dir ?? "")}
        </span>

        {/* 路径与分支分隔线 */}
        <span aria-hidden="true" style={{ width: 1, height: 12, background: "var(--c-border-2)", flexShrink: 0 }} />

        {/* Git 分支 */}
        <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1, minWidth: 0 }}>
          ⎇ {active?.branch || "-"}
        </span>

        {/* Remote ahead/behind */}
        {remote?.state === "ok" && (remote.ahead > 0 || remote.behind > 0) && (
          <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", fontWeight: 500, fontFamily: "var(--font-mono)", flexShrink: 0, display: "inline-flex", gap: 3 }}>
            {remote.ahead > 0 && (
              <span style={{ color: "var(--c-success)" }}>↑{remote.ahead}</span>
            )}
            {remote.behind > 0 && (
              <span style={{ color: "var(--c-warning)" }}>↓{remote.behind}</span>
            )}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {/* 分栏控制 */}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {isSplit ? (
            <button
              onClick={() => {
                const ui = useUIStore.getState();
                const paneAId = ui.split.paneA;
                if (paneAId) useSessionsStore.getState().setActive(paneAId);
                ui.closeSplit();
              }}
              title="关闭分栏"
              aria-label="关闭分栏"
              style={{
                width: 24,
                height: 22,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "var(--r-btn)",
              }}
              className="hover-bg"
            >
              <SplitIcon direction="single" />
            </button>
          ) : (
            <>
              <button
                onClick={() => useSessionsStore.getState().splitWithNewSession("horizontal")}
                title="左右分栏 ⌘D"
                aria-label="左右分栏"
                style={{
                  width: 24,
                  height: 22,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--r-btn)",
                }}
                className="hover-bg"
              >
                <SplitIcon direction="columns" />
              </button>
              <button
                onClick={() => useSessionsStore.getState().splitWithNewSession("vertical")}
                title="上下分栏 ⌘⇧D"
                aria-label="上下分栏"
                style={{
                  width: 24,
                  height: 22,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--r-btn)",
                }}
                className="hover-bg"
              >
                <SplitIcon direction="rows" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
