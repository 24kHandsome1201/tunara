import { useEffect, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./agents";
import { isAgentActivityBusy } from "@/modules/terminal/lib/agent-lifecycle";
import { buildAgentResumeCommand } from "@/modules/terminal/lib/agent-resume";
import { useSessionsStore } from "@/state/sessions";

interface AgentStatusBarProps {
  session: Session;
}

export function AgentStatusBar({ session }: AgentStatusBarProps) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [lastAgent, setLastAgent] = useState(session.agent);

  const agentCode = session.agent ?? lastAgent;
  const resumeCommand = buildAgentResumeCommand(session.agentResume);
  const resumeAgent = !session.agent && resumeCommand ? session.agentResume?.agent : undefined;
  const displayAgent = agentCode ?? resumeAgent;
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

  if ((!visible && !resumeCommand) || !displayAgent) return null;

  const fileCount = session.changes?.files.length ?? 0;
  const agentName = (AGENT_NAMES as Record<string, string>)[displayAgent] ?? displayAgent;
  const fillResumeCommand = () => {
    if (!resumeCommand) return;
    useSessionsStore.getState().updateSession(session.id, {
      pendingInput: resumeCommand,
      pendingInputSubmit: false,
    });
  };

  const statusLabel = resumeCommand && !session.agent ? "可恢复" : isBusy ? (isStarting ? "加载中" : "运行中") : "已完成";
  const statusColor = resumeCommand && !session.agent
    ? "var(--c-warning)"
    : isBusy
      ? "var(--c-accent)"
      : "var(--c-success)";

  return (
    <div
      style={{
        height: 30,
        margin: "4px 8px 0",
        flexShrink: 0,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 8,
        opacity: fading ? 0 : 1,
        transform: fading ? "translateY(-4px) scale(0.98)" : "translateY(0) scale(1)",
        transition: "opacity var(--duration-normal) var(--ease-smooth), transform var(--duration-normal) var(--ease-out-expo)",
        animation: !fading ? "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)" : undefined,
      }}
    >
      {displayAgent && <AgentBadge agent={displayAgent} size={18} />}
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>
        {agentName}
      </span>
      <span style={{
        fontSize: "var(--fs-badge)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: statusColor,
        background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
        borderRadius: 4,
        padding: "1px 6px",
        lineHeight: "16px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
      }}>
        {isBusy && (
          <span style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: statusColor,
            animation: "pulseDot 1.5s var(--ease-in-out) infinite",
            boxShadow: `0 0 6px color-mix(in srgb, ${statusColor} 40%, transparent)`,
            flexShrink: 0,
          }} />
        )}
        {statusLabel}
      </span>
      {resumeCommand && !session.agent && (
        <button
          onClick={fillResumeCommand}
          className="hover-accent-bg"
          style={{
            marginLeft: "auto",
            height: 22,
            borderRadius: "var(--r-btn)",
            border: "1px solid var(--c-accent-border)",
            background: "var(--c-accent-bg-soft)",
            color: "var(--c-accent)",
            fontSize: "var(--fs-meta)",
            fontWeight: 600,
            cursor: "pointer",
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            transition: "background var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          恢复
        </button>
      )}
      {fileCount > 0 && (
        <span style={{
          marginLeft: resumeCommand && !session.agent ? 0 : "auto",
          fontSize: "var(--fs-badge)",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: "var(--c-text-4)",
          background: "var(--c-bg-3)",
          borderRadius: 4,
          padding: "1px 6px",
          lineHeight: "14px",
          flexShrink: 0,
        }}>
          {fileCount} 文件
        </span>
      )}
    </div>
  );
}
