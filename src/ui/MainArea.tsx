import { useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalView";
import { type Session, AGENT_NAMES } from "./types";
import { gitAheadBehind, gitStatus, type RemoteState } from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SplitHandle } from "./SplitHandle";
import { AgentStatusBar } from "./AgentStatusBar";
import { isAgentActivityBusy } from "@/modules/terminal/lib/agent-lifecycle";

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

  function renderTerminalPane(s: Session, isActive: boolean) {
    return (
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <AgentStatusBar session={s} />
        <TerminalView
          sessionId={s.id}
          dir={s.dir}
          active={isActive}
          pendingInput={s.pendingInput}
          onPendingInputConsumed={() => useSessionsStore.getState().updateSession(s.id, { pendingInput: undefined })}
        />
      </div>
    );
  }

  const isSplit = split.mode !== "single" && paneASession && paneBSession && paneASession.id !== paneBSession.id;
  const isHorizontal = split.mode === "horizontal";
  const visibleIds = new Set<string>();
  if (isSplit) {
    visibleIds.add(paneASession.id);
    visibleIds.add(paneBSession.id);
  } else if (active?.id) {
    visibleIds.add(active.id);
  }

  const mountedIdsForRender = new Set(Object.keys(launchedSessionIds));
  const mountedSessions = sessions.filter((s) => mountedIdsForRender.has(s.id));
  const hiddenMountedSessions = mountedSessions.filter((s) => !visibleIds.has(s.id));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--c-bg-white)", overflow: "hidden", minWidth: 0 }}>
      <div ref={splitContainerRef} style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: isSplit ? (isHorizontal ? "row" : "column") : "row" }}>
        {isSplit ? (
          <>
            <div
              onClick={() => useSessionsStore.getState().setActive(paneASession!.id)}
              style={{
                [isHorizontal ? "width" : "height"]: `calc(${split.ratio * 100}% - 2.5px)`,
                display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden",
                borderRadius: 6,
                outline: paneASession!.id === activeSessionId ? "1px solid var(--c-accent)" : "1px solid transparent",
                outlineOffset: -1,
                transition: "outline-color var(--duration-fast) ease",
              }}
            >
              {renderTerminalPane(paneASession!, paneASession!.id === activeSessionId)}
            </div>
            <SplitHandle mode={split.mode as "horizontal" | "vertical"} containerRef={splitContainerRef} />
            <div
              onClick={() => useSessionsStore.getState().setActive(paneBSession!.id)}
              style={{
                [isHorizontal ? "width" : "height"]: `calc(${(1 - split.ratio) * 100}% - 2.5px)`,
                display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden",
                borderRadius: 6,
                outline: paneBSession!.id === activeSessionId ? "1px solid var(--c-accent)" : "1px solid transparent",
                outlineOffset: -1,
                transition: "outline-color var(--duration-fast) ease",
              }}
            >
              {renderTerminalPane(paneBSession!, paneBSession!.id === activeSessionId)}
            </div>
            {hiddenMountedSessions.map((s) => (
              <div key={s.id} style={{ display: "none" }}>
                {renderTerminalPane(s, false)}
              </div>
            ))}
          </>
        ) : (
          mountedSessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: isActive ? "flex" : "none",
                  flexDirection: "column",
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                {renderTerminalPane(s, isActive)}
              </div>
            );
          })
        )}
      </div>

      <div
        style={{
          height: "var(--h-statusbar)",
          background: "var(--c-bg-1)",
          borderTop: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-shell-path)", fontFamily: "var(--font-mono)", flex: "1 1 96px", minWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={active?.dir ?? ""}>
          {compactPath(active?.dir ?? "")}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "55%", overflow: "hidden", flexShrink: 1 }}>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>·</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            ⎇ {active?.branch || "-"}
          </span>
          {remote?.state === "ok" && (remote.ahead > 0 || remote.behind > 0) && (
            <>
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>·</span>
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                {remote.ahead > 0 && `↑${remote.ahead}`}{remote.ahead > 0 && remote.behind > 0 && " "}{remote.behind > 0 && `↓${remote.behind}`}
              </span>
            </>
          )}
          {active?.agent && (
            <>
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>·</span>
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-accent)", fontFamily: "var(--font-mono)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {AGENT_NAMES[active.agent] ?? active.agent}
                {isAgentActivityBusy(active.agentActivity) && (
                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-accent)", flexShrink: 0 }} />
                )}
              </span>
            </>
          )}
        </div>

        <span style={{ marginLeft: "auto" }} />

        {isSplit ? (
          <button
            onClick={() => {
              const ui = useUIStore.getState();
              const paneBId = ui.split.paneB;
              if (paneBId) useSessionsStore.getState().closeSession(paneBId);
              else ui.closeSplit();
            }}
            title="关闭分栏"
            aria-label="关闭分栏"
            style={{
              width: 28,
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
                width: 28,
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
                width: 28,
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
  );
}
