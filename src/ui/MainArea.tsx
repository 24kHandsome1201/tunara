import { useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalView";
import { type Session, AGENT_NAMES } from "./types";
import { gitAheadBehind, type RemoteState } from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SplitHandle } from "./SplitHandle";
import { AgentStatusBar } from "./AgentStatusBar";

interface MainAreaProps {
  sessions: Session[];
  activeSessionId: string;
}

export function MainArea({ sessions, activeSessionId }: MainAreaProps) {
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const nonce = useSessionsStore((s) => s.gitNonce[active?.id ?? ""] ?? 0);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const split = useUIStore((s) => s.split);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const paneBSession = split.paneB ? sessions.find((s) => s.id === split.paneB) : null;

  useEffect(() => {
    if (!active?.dir) return;
    let cancelled = false;
    gitAheadBehind(active.dir)
      .then((r) => !cancelled && setRemote(r))
      .catch(() => !cancelled && setRemote(null));
    return () => { cancelled = true; };
  }, [active?.dir, active?.id, nonce]);

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

  const isSplit = split.mode !== "single" && paneBSession;
  const isHorizontal = split.mode === "horizontal";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--c-bg-white)", overflow: "hidden", minWidth: 0 }}>
      <div ref={splitContainerRef} style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: isSplit ? (isHorizontal ? "row" : "column") : "row" }}>
        {isSplit ? (
          <>
            <div style={{ [isHorizontal ? "width" : "height"]: `calc(${split.ratio * 100}% - 2.5px)`, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
              {sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                return (
                  <div
                    key={s.id}
                    style={{
                      position: isActive ? "relative" : "absolute",
                      inset: 0,
                      display: isActive ? "flex" : "none",
                      flexDirection: "column",
                      minWidth: 0,
                      minHeight: 0,
                      flex: isActive ? 1 : undefined,
                    }}
                  >
                    {renderTerminalPane(s, isActive)}
                  </div>
                );
              })}
            </div>
            <SplitHandle mode={split.mode as "horizontal" | "vertical"} containerRef={splitContainerRef} />
            <div style={{ [isHorizontal ? "width" : "height"]: `calc(${(1 - split.ratio) * 100}% - 2.5px)`, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
              {renderTerminalPane(paneBSession, true)}
            </div>
          </>
        ) : (
          sessions.map((s) => {
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
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-shell-path)", fontFamily: "var(--font-mono)" }}>
          {active?.dir ?? ""}
        </span>
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
          ⎇ {active?.branch || "—"}
        </span>
        {remote?.state === "ok" && (remote.ahead > 0 || remote.behind > 0) && (
          <>
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
              {remote.ahead > 0 && `↑${remote.ahead}`}{remote.ahead > 0 && remote.behind > 0 && " "}{remote.behind > 0 && `↓${remote.behind}`}
            </span>
          </>
        )}
        {active?.agent && (
          <>
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-accent)", fontFamily: "var(--font-mono)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
              {AGENT_NAMES[active.agent] ?? active.agent}
              {active.runState === "running" && (
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-accent)", flexShrink: 0 }} />
              )}
            </span>
          </>
        )}

        <span style={{ marginLeft: "auto" }} />

        {isSplit ? (
          <button
            onClick={() => {
              const ui = useUIStore.getState();
              const paneBId = ui.split.paneB;
              ui.closeSplit();
              if (paneBId) useSessionsStore.getState().removeSession(paneBId);
            }}
            title="关闭分栏"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "2px 4px",
              borderRadius: "var(--r-btn)",
            }}
            className="hover-bg"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
            </svg>
          </button>
        ) : (
          <>
            <button
              onClick={() => useSessionsStore.getState().splitWithNewSession("horizontal")}
              title="水平分栏 ⌘D"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2px 4px",
                borderRadius: "var(--r-btn)",
              }}
              className="hover-bg"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <line x1="8" y1="1.5" x2="8" y2="14.5" />
              </svg>
            </button>
            <button
              onClick={() => useSessionsStore.getState().splitWithNewSession("vertical")}
              title="垂直分栏 ⌘⇧D"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2px 4px",
                borderRadius: "var(--r-btn)",
              }}
              className="hover-bg"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <line x1="1.5" y1="8" x2="14.5" y2="8" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
