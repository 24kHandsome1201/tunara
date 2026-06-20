import { useEffect, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./SessionCard";

interface AgentStatusBarProps {
  session: Session;
}

export function AgentStatusBar({ session }: AgentStatusBarProps) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);

  const isRunning = session.runState === "running" && !!session.agent;
  const isDone = (session.runState === "done" || session.runState === "failed") && !session.agent;

  useEffect(() => {
    if (isRunning) {
      setVisible(true);
      setFading(false);
    } else if (visible && isDone) {
      setFading(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, 3000);
      return () => clearTimeout(timer);
    } else if (!isRunning && !isDone) {
      setVisible(false);
      setFading(false);
    }
  }, [isRunning, isDone, visible]);

  if (!visible) return null;

  const agentCode = session.agent;
  const fileCount = session.changes?.files.length ?? 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 4,
        left: 8,
        right: 8,
        height: 32,
        zIndex: 20,
        background: "var(--c-bg-1-glass)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 8,
        opacity: fading ? 0 : 1,
        transition: "opacity 0.5s ease",
        pointerEvents: "none",
      }}
    >
      {agentCode && <AgentBadge agent={agentCode} size={18} />}
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>
        {agentCode ? (AGENT_NAMES[agentCode] ?? agentCode) : ""}
      </span>
      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>·</span>
      <span style={{ fontSize: "var(--fs-meta)", color: isRunning ? "var(--c-accent)" : "var(--c-text-5)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 4 }}>
        {isRunning ? "运行中" : "已完成"}
        {isRunning && (
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-accent)", animation: "pulseDot 1.2s ease infinite" }} />
        )}
      </span>
      {fileCount > 0 && (
        <>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>·</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
            已编辑 {fileCount} 文件
          </span>
        </>
      )}
    </div>
  );
}
