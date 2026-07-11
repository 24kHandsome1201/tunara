import { useEffect, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./agents";
import { hasCompletedAgentTurn, isAgentActivityBusy } from "@/modules/terminal/lib/agent-lifecycle";
import { agentResumePendingInput, buildAgentResumeLaunchCommand } from "@/modules/terminal/lib/agent-resume";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { AccentActionButton, ResumeIcon } from "./lib/ui-primitives";

interface AgentStatusBarProps {
  session: Session;
}

export function AgentStatusBar({ session }: AgentStatusBarProps) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [lastAgent, setLastAgent] = useState(session.agent);

  const agentCode = session.agent ?? lastAgent;
  const resumeCommand = buildAgentResumeLaunchCommand(session.agentResume, session);
  const resumeAgent = !session.agent && resumeCommand ? session.agentResume?.agent : undefined;
  const displayAgent = session.agent ?? resumeAgent ?? agentCode;
  const isBusy = !!session.agent && isAgentActivityBusy(session.agentActivity);
  const isWaitingConfirmation = !!session.agent && session.agentActivity === "waiting_confirmation";
  const isStarting = session.agentActivity === "starting";
  const isCompletedTurn = visible && hasCompletedAgentTurn(session);

  useEffect(() => {
    if (session.agent) setLastAgent(session.agent);
  }, [session.agent]);

  useEffect(() => {
    if (isBusy || isWaitingConfirmation) {
      setVisible(true);
      setFading(false);
    } else if (isCompletedTurn) {
      // 等一段时间让用户看到"已完成"，再触发出场动画
      const timer = setTimeout(() => setFading(true), 1200);
      return () => clearTimeout(timer);
    } else if (!session.agent) {
      setVisible(false);
      setFading(false);
    }
  }, [isBusy, isWaitingConfirmation, isCompletedTurn, session.agent]);

  // A prompt-aware agent reaching its first ready prompt only completed
  // startup. It has no completedAt evidence and must never flash "Done".
  if (session.agent && session.agentActivity === "idle" && !hasCompletedAgentTurn(session)) return null;
  if ((!visible && !resumeCommand) || !displayAgent) return null;

  const fileCount = session.changes?.files.length ?? 0;
  const agentName = (AGENT_NAMES as Record<string, string>)[displayAgent] ?? displayAgent;
  const fillResumeCommand = () => {
    if (!resumeCommand) return;
    useSessionsStore.getState().updateSession(session.id, agentResumePendingInput(resumeCommand));
  };

  const statusLabel = resumeCommand && !session.agent
    ? t("agent.status.resumable")
    : isWaitingConfirmation
      ? t("agent.status.waiting_confirmation")
    : isBusy
      ? (isStarting ? t("sidebar.agent.activity.starting") : t("sidebar.agent.activity.running"))
      : t("agent.status.done");
  const statusColor = resumeCommand && !session.agent
    ? "var(--c-success)"
    : isWaitingConfirmation
      ? "var(--c-warning-text)"
    : isBusy
      ? "var(--c-accent)"
      : "var(--c-success)";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onAnimationEnd={(e) => {
        if (fading && e.animationName === "statusBarSlideOut") {
          setVisible(false);
          setFading(false);
        }
      }}
      style={{
        minHeight: "var(--h-inline-bar)",
        flexShrink: 0,
        background: "var(--c-bg-2)",
        borderBottom: "1px solid var(--c-border-1)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 8,
        animation: fading
          ? "statusBarSlideOut var(--duration-fast) var(--ease-smooth) forwards"
          : "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)",
      }}
    >
      {displayAgent && <AgentBadge agent={displayAgent} size={18} />}
      <span style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-primary)", lineHeight: "16px" }}>
        {agentName}
      </span>
      <span style={{
        fontSize: "var(--fs-meta)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: statusColor,
        padding: 0,
        lineHeight: "16px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
      }}>
        {(isBusy || isWaitingConfirmation) && (
          <span style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: statusColor,
            flexShrink: 0,
          }} aria-hidden="true" />
        )}
        {statusLabel}
      </span>
      {resumeCommand && !session.agent && (
        <AccentActionButton
          onClick={fillResumeCommand}
          title={t("agent.status.resume")}
          ariaLabel={t("agent.status.resume")}
          style={{ marginLeft: "auto" }}
        >
          <ResumeIcon size={10} />
          {t("agent.status.resume")}
        </AccentActionButton>
      )}
      {fileCount > 0 && (
        <span style={{
          marginLeft: resumeCommand && !session.agent ? 0 : "auto",
          fontSize: "var(--fs-meta)",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: "var(--c-text-4)",
          background: "var(--c-bg-3)",
          borderRadius: "var(--r-badge-sm)",
          padding: "1px 6px",
          lineHeight: "16px",
          flexShrink: 0,
        }}>
          {t("agent.status.file_count", { count: fileCount })}
        </span>
      )}
    </div>
  );
}
