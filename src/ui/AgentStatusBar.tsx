import { useEffect, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./agents";
import { isAgentActivityBusy } from "@/modules/terminal/lib/agent-lifecycle";

interface AgentStatusBarProps {
  session: Session;
}

export function AgentStatusBar({ session }: AgentStatusBarProps) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [lastAgent, setLastAgent] = useState(session.agent);

  const agentCode = session.agent ?? lastAgent;
  const isBusy = !!session.agent && isAgentActivityBusy(session.agentActivity);
  const isStarting = session.agentActivity === "starting";
  const isIdleAfterBusy = visible && !!session.agent && session.agentActivity === "idle";

  useEffect(() => {
    if (session.agent) setLastAgent(session.agent);
  }, [session.agent]);

  useEffect(() => {
    if (isBusy) {
      setVisible(true);
      setFading(false);
    } else if (isIdleAfterBusy) {
      setFading(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, 1500);
      return () => clearTimeout(timer);
    } else if (!session.agent) {
      setVisible(false);
      setFading(false);
    }
  }, [isBusy, isIdleAfterBusy, session.agent]);

  if (!visible || !agentCode) return null;

  const fileCount = session.changes?.files.length ?? 0;

  return (
    <div
      style={{
        height: 32,
        margin: "4px 8px 0",
        flexShrink: 0,
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
        transition: "opacity 0.3s ease",
        pointerEvents: "none",
      }}
    >
      {agentCode && <AgentBadge agent={agentCode} size={18} />}
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>
        {agentCode ? (AGENT_NAMES[agentCode] ?? agentCode) : ""}
      </span>
      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>·</span>
      <span style={{ fontSize: "var(--fs-meta)", color: isBusy ? "var(--c-accent)" : "var(--c-text-5)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 4 }}>
        {isBusy ? (isStarting ? "加载中" : "运行中") : "已完成"}
        {isBusy && (
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-accent)" }} />
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
