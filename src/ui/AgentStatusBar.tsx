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
        transition: "opacity 0.3s ease",
        animation: !fading ? "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)" : undefined,
      }}
    >
      {displayAgent && <AgentBadge agent={displayAgent} size={18} />}
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>
        {agentName}
      </span>
      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>·</span>
      <span style={{ fontSize: "var(--fs-meta)", color: isBusy ? "var(--c-accent)" : "var(--c-text-5)", fontFamily: "var(--font-mono)", display: "flex", alignItems: "center", gap: 4 }}>
        {resumeCommand && !session.agent ? "可恢复" : isBusy ? (isStarting ? "加载中" : "运行中") : "已完成"}
        {isBusy && (
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--c-accent)", animation: "pulseDot 1.5s var(--ease-in-out) infinite", boxShadow: "0 0 6px color-mix(in srgb, var(--c-accent) 40%, transparent)" }} />
        )}
      </span>
      {resumeCommand && !session.agent && (
        <button
          onClick={fillResumeCommand}
          style={{ marginLeft: "auto", height: 22, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-meta)", fontWeight: 600, cursor: "pointer", padding: "0 8px" }}
          className="hover-bg"
        >
          填入
        </button>
      )}
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
