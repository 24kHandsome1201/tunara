import { useMemo, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./agents";
import { groupAgentActivity } from "@/modules/agent/global-activity";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { AccentActionButton, ResumeIcon } from "./lib/ui-primitives";

// 全局 Agent 活动条（.design/global-agent-bar.html 原型的实现）。
// 挂在 Sidebar 顶部：折叠时一行汇总计数，展开后按 等你回复/正在跑/可恢复 分组。
// 没有任何 agent 相关会话时整条隐藏——不留空壳。
interface GlobalAgentBarProps {
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

function rowName(session: Session, fallbackAgent?: string): string {
  if (session.customTitle) return session.customTitle;
  const code = session.agent ?? fallbackAgent;
  if (code) return (AGENT_NAMES as Record<string, string>)[code] ?? code;
  return session.title;
}

function CountChip({ count, color, label }: { count: number; color: string; label: string }) {
  if (count === 0) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-meta)",
        fontWeight: 700,
        padding: "2px 7px 2px 6px",
        borderRadius: "var(--r-pill)",
        lineHeight: "14px",
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function GroupLabel({ label, count, accent }: { label: string; count: number; accent?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--fs-badge)",
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: accent ? "var(--c-accent)" : "var(--c-text-5)",
        padding: "7px 8px 5px",
      }}
    >
      {label}
      <span style={{ color: "var(--c-text-6)", fontFamily: "var(--font-mono)" }}>{count}</span>
    </div>
  );
}

interface ActivityRowProps {
  session: Session;
  variant: "wait" | "run" | "resumable";
  resumeCommand?: string;
  onSelect: (id: string) => void;
}

function ActivityRow({ session, variant, resumeCommand, onSelect }: ActivityRowProps) {
  const t = useT();
  const agentCode = session.agent ?? session.agentResume?.agent;
  const fileCount = session.changes?.files.length ?? 0;
  const tagColor = variant === "run" ? "var(--c-accent)" : "var(--c-warning)";
  const tagLabel = variant === "wait"
    ? t("gbar.tag.wait")
    : session.agentActivity === "starting"
      ? t("gbar.tag.starting")
      : t("gbar.tag.run");

  const select = () => onSelect(session.id);
  const fillResume = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resumeCommand) return;
    useSessionsStore.getState().updateSession(session.id, {
      pendingInput: resumeCommand,
      pendingInputSubmit: false,
    });
    onSelect(session.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={variant === "wait" ? "gbar-row gbar-row-wait" : "gbar-row"}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: "var(--r-btn)",
        cursor: "pointer",
        position: "relative",
        minWidth: 0,
      }}
    >
      <AgentBadge agent={agentCode} size={18} />
      <span
        className="text-ellipsis"
        style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)", flexShrink: 0, maxWidth: "52%" }}
      >
        {rowName(session, agentCode)}
      </span>
      <span
        className="text-ellipsis"
        style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}
      >
        {session.dir}
      </span>
      {variant === "wait" && fileCount > 0 && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-meta)",
            fontWeight: 600,
            color: "var(--c-text-4)",
            background: "var(--c-bg-3)",
            borderRadius: "var(--r-badge-sm)",
            padding: "1px 5px",
            lineHeight: "14px",
            flexShrink: 0,
          }}
        >
          {t("agent.status.file_count", { count: fileCount })}
        </span>
      )}
      {variant === "resumable" ? (
        <AccentActionButton onClick={fillResume} title={t("agent.status.resume")} ariaLabel={t("agent.status.resume")}>
          <ResumeIcon size={9} />
          {t("agent.status.resume")}
        </AccentActionButton>
      ) : (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-meta)",
            fontWeight: 700,
            lineHeight: "14px",
            padding: "1px 7px",
            borderRadius: "var(--r-pill)",
            color: tagColor,
            background: `color-mix(in srgb, ${tagColor} 12%, transparent)`,
            flexShrink: 0,
          }}
        >
          {variant === "run" && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: tagColor,
                flexShrink: 0,
              }}
            />
          )}
          {tagLabel}
        </span>
      )}
    </div>
  );
}

export function GlobalAgentBar({ sessions, onSelectSession }: GlobalAgentBarProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupAgentActivity(sessions), [sessions]);

  if (groups.total === 0) return null;

  const liveCount = groups.wait.length + groups.run.length;

  return (
    <div style={{ padding: "2px 12px 6px", flexShrink: 0 }}>
      <div
        style={{
          overflow: "hidden",
        }}
      >
        <button
          className="gbar-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={t("gbar.aria_label")}
          style={{
            width: "100%",
            height: 30,
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 8px 0 10px",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <span
            style={{
              fontSize: "var(--fs-meta)",
              fontWeight: 700,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: "var(--c-text-5)",
              flexShrink: 0,
            }}
          >
            {t("gbar.title")}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", minWidth: 0 }}>
            <CountChip
              count={groups.wait.length}
              color="var(--c-warning)"
              label={t("gbar.count.wait", { count: groups.wait.length })}
            />
            <CountChip
              count={groups.run.length}
              color="var(--c-accent)"
              label={t("gbar.count.run", { count: groups.run.length })}
            />
            {liveCount === 0 && (
              <CountChip
                count={groups.resumable.length}
                color="var(--c-success)"
                label={t("gbar.count.resumable", { count: groups.resumable.length })}
              />
            )}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--c-text-6)"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              flexShrink: 0,
              transform: open ? "rotate(90deg)" : undefined,
              transition: "transform var(--duration-normal) var(--ease-out-expo)",
            }}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        <div
          style={{
            display: "grid",
            gridTemplateRows: open ? "1fr" : "0fr",
            transition: "grid-template-rows var(--duration-normal) var(--ease-out-expo)",
          }}
        >
          <div style={{ overflow: "hidden", minHeight: 0 }}>
            <div
              className="no-scrollbar"
              style={{ borderTop: "1px solid var(--c-border-1)", padding: 6, maxHeight: 280, overflowY: "auto" }}
            >
              {groups.wait.length > 0 && (
                <div role="group" aria-label={t("gbar.group.wait")}>
                  <GroupLabel label={t("gbar.group.wait")} count={groups.wait.length} accent />
                  {groups.wait.map((s) => (
                    <ActivityRow key={s.id} session={s} variant="wait" onSelect={onSelectSession} />
                  ))}
                </div>
              )}
              {groups.run.length > 0 && (
                <div role="group" aria-label={t("gbar.group.run")}>
                  <GroupLabel label={t("gbar.group.run")} count={groups.run.length} />
                  {groups.run.map((s) => (
                    <ActivityRow key={s.id} session={s} variant="run" onSelect={onSelectSession} />
                  ))}
                </div>
              )}
              {groups.resumable.length > 0 && (
                <div role="group" aria-label={t("gbar.group.resumable")}>
                  <GroupLabel label={t("gbar.group.resumable")} count={groups.resumable.length} />
                  {groups.resumable.map(({ session, resumeCommand }) => (
                    <ActivityRow
                      key={session.id}
                      session={session}
                      variant="resumable"
                      resumeCommand={resumeCommand}
                      onSelect={onSelectSession}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
