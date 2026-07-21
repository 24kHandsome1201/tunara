import { memo, useRef } from "react";
import { TerminalView } from "./TerminalView";
import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SplitHandle } from "./SplitHandle";
import { SshSuggestionBar } from "./SshSuggestionBar";
import { useT } from "@/modules/i18n";
import { formatShortcut } from "./formatShortcut";
import { getNumberRecordValue } from "@/state/record-keys";
import { useSessionGitContext } from "./useSessionGitContext";
import { useWorkspaceHydration } from "./useWorkspaceHydration";
import { splitLayoutGeometry, splitLayoutSessionIds } from "@/modules/session/split-layout";

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
    <div data-terminal-session-id={session.id} style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <SshSuggestionBar session={session} />
      <TerminalView
        key={`${session.id}:${session.reconnectNonce ?? 0}`}
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
  const t = useT();
  const splitHorizontalShortcut = useUIStore((s) => s.keybindings.splitHorizontal);
  const splitVerticalShortcut = useUIStore((s) => s.keybindings.splitVertical);
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const activeIsRemote = Boolean(active?.remote);
  const nonce = useSessionsStore((s) => active ? getNumberRecordValue(s.gitNonce, active.id) : 0);
  const launchedSessionIds = useSessionsStore((s) => s.launchedSessionIds);
  const split = useUIStore((s) => s.split);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Captured as primitives so the git effect depends on exactly the fields it
  // reads. Depending on the whole `active` object would re-run the effect on
  // every session mutation (updatedAt bumps on each patch) — and since the
  // effect itself calls updateSession, that would loop.
  const activeId = active?.id;
  const activeDir = active?.dir;
  const activePtyId = active?.ptyId;
  const activeRemoteKey = active?.remote
    ? `${active.remote.user}@${active.remote.host}:${active.remote.port}`
    : undefined;

  const remote = useSessionGitContext({
    activeId,
    activeDir,
    activePtyId,
    activeIsRemote,
    activeRemoteKey,
    nonce,
  });
  useWorkspaceHydration(sessions, activeId);

  function compactPath(path: string): string {
    if (path.length <= 48) return path;
    const normalized = path.replace(/^\/Users\/[^/]+/, "~");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 3) return normalized;
    return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
  }

  const isSplit = split.root !== null;
  const splitGeometry = splitLayoutGeometry(split);

  const mountedIdsForRender = new Set(Object.keys(launchedSessionIds));
  const mountedSessions = sessions.filter((s) => mountedIdsForRender.has(s.id));

  // Every mounted session keeps a stable, keyed wrapper across single<->split
  // transitions so React never unmounts its TerminalView (which would close the
  // PTY and kill any running agent). The BSP tree only provides normalized
  // rectangles; every terminal remains a stable root-level sibling.
  function paneWrapperStyle(s: Session): React.CSSProperties {
    const pane = splitGeometry.panes[s.id];

    if (isSplit && pane) {
      const leftInset = pane.x > 0 ? 2.5 : 0;
      const topInset = pane.y > 0 ? 2.5 : 0;
      const rightInset = pane.x + pane.width < 1 ? 2.5 : 0;
      const bottomInset = pane.y + pane.height < 1 ? 2.5 : 0;
      const activeMarker = pane.parentDirection === "horizontal"
        ? "inset 2px 0 0 var(--c-accent)"
        : "inset 0 2px 0 var(--c-accent)";
      return {
        position: "absolute",
        left: `calc(${pane.x * 100}% + ${leftInset}px)`,
        top: `calc(${pane.y * 100}% + ${topInset}px)`,
        width: `calc(${pane.width * 100}% - ${leftInset + rightInset}px)`,
        height: `calc(${pane.height * 100}% - ${topInset + bottomInset}px)`,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        borderRadius: "var(--r-btn)",
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
      <div ref={splitContainerRef} style={{ flex: 1, position: "relative", minHeight: 0 }}>
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
        {splitGeometry.handles.map((handle) => (
          <SplitHandle
            key={handle.path}
            direction={handle.direction}
            path={handle.path}
            ratio={handle.ratio}
            nodeRect={handle.nodeRect}
            containerRef={splitContainerRef}
          />
        ))}
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
        <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-shell-path)", fontFamily: "var(--font-mono)", fontWeight: 500, flex: "0 1 auto", minWidth: 48, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={active?.dir ?? ""}>
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
                const firstPaneId = splitLayoutSessionIds(ui.split)[0];
                if (firstPaneId) useSessionsStore.getState().setActive(firstPaneId);
                ui.closeSplit();
              }}
              title={t("split.close")}
              aria-label={t("split.close")}
              style={{
                width: 28,
                height: "var(--h-btn-sm)",
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
                title={`${t("split.horizontal")} ${formatShortcut(splitHorizontalShortcut)}`}
                aria-label={t("split.horizontal")}
                style={{
                  width: 28,
                  height: "var(--h-btn-sm)",
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
                title={`${t("split.vertical")} ${formatShortcut(splitVerticalShortcut)}`}
                aria-label={t("split.vertical")}
                style={{
                  width: 28,
                  height: "var(--h-btn-sm)",
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
