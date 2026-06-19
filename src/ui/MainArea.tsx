import { TerminalView } from "./TerminalView";
import { type Session } from "./types";

interface MainAreaProps {
  sessions: Session[];
  activeSessionId: string;
  onAgentDetected?: (sessionId: string, agent: import("./types").AgentCode) => void;
  onAgentExited?: (sessionId: string) => void;
  onCommandDetected?: (sessionId: string, command: string) => void;
  onCwd?: (sessionId: string, cwd: string) => void;
  onShellTitle?: (sessionId: string, title: string) => void;
}

export function MainArea({ sessions, activeSessionId, onAgentDetected, onAgentExited, onCommandDetected, onCwd, onShellTitle }: MainAreaProps) {
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--c-bg-white)", overflow: "hidden", minWidth: 0 }}>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {sessions.map((s) => {
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
              <TerminalView
                dir={s.dir}
                active={isActive}
                onAgentCommandSubmitted={onAgentDetected ? (agent) => onAgentDetected(s.id, agent) : undefined}
                onAgentExited={onAgentExited ? () => onAgentExited(s.id) : undefined}
                onCommandDetected={onCommandDetected ? (cmd) => onCommandDetected(s.id, cmd) : undefined}
                onCwd={onCwd ? (cwd) => onCwd(s.id, cwd) : undefined}
                onShellTitle={onShellTitle ? (title) => onShellTitle(s.id, title) : undefined}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          height: "var(--h-statusbar)",
          background: "var(--c-bg-1)",
          borderTop: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11.5, color: "var(--c-shell-path)", fontFamily: "var(--font-mono)" }}>
          {active?.dir ?? ""}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>·</span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
          ⎇ {active?.branch || "—"}
        </span>
      </div>
    </div>
  );
}
