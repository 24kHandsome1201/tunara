import { useMemo, useState } from "react";
import { type Session, AGENT_NAMES } from "./types";
import { AgentBadge } from "./agents";
import { deriveSessionAttention, type SessionAttentionKind } from "@/modules/session/session-attention";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { AccentActionButton, RestartIcon, ResumeIcon } from "./lib/ui-primitives";

// Sidebar 的统一会话动态层。展示需要处理、正在运行、可恢复三类派生状态；
// 没有可操作状态时整条隐藏，不制造第二套持久化状态或独立工作区。
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
  variant: "attention" | "run" | "resumable";
  attentionKind?: SessionAttentionKind;
  resumeCommand?: string;
  onSelect: (id: string) => void;
}

function ActivityRow({ session, variant, attentionKind, resumeCommand, onSelect }: ActivityRowProps) {
  const t = useT();
  const agentCode = session.agent ?? session.agentResume?.agent;
  const fileCount = session.changes?.files.length ?? 0;
  const isSshAttention = attentionKind === "ssh-failed" || attentionKind === "ssh-disconnected";
  const tagColor = variant === "run"
    ? "var(--c-accent)"
    : attentionKind === "agent-ready"
      ? "var(--c-warning)"
      : "var(--c-error)";
  const tagLabel = attentionKind === "agent-ready"
    ? t("gbar.tag.wait")
    : attentionKind === "command-failed"
      ? t("gbar.tag.command_failed")
      : attentionKind === "ssh-disconnected"
        ? t("gbar.tag.ssh_disconnected")
        : attentionKind === "ssh-failed"
          ? t("gbar.tag.ssh_failed")
          : session.agentActivity === "starting"
            ? t("gbar.tag.starting")
            : t("gbar.tag.run");
  const displayName = isSshAttention && session.remote
    ? `${session.remote.user}@${session.remote.host}`
    : rowName(session, agentCode);

  const select = () => onSelect(session.id);
  const fillResume = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resumeCommand) return;
    useSessionsStore.getState().updateSession(session.id, {
      pendingInput: resumeCommand,
      pendingInputSubmit: true,
    });
    onSelect(session.id);
  };
  const reconnect = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session.remote) return;
    useUIStore.getState().openSshConnect({
      host: session.remote.host,
      user: session.remote.user,
      port: session.remote.port,
      identityFile: session.remote.identityFile,
      injectShellIntegration: session.remote.injectShellIntegration,
      reconnectSessionId: session.id,
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={variant === "attention" ? "gbar-row gbar-row-wait" : "gbar-row"}
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
      {agentCode ? (
        <AgentBadge agent={agentCode} size={18} />
      ) : (
        <span
          aria-hidden="true"
          style={{ width: 18, height: 18, borderRadius: "var(--r-badge)", display: "grid", placeItems: "center", flexShrink: 0, color: tagColor, background: `color-mix(in srgb, ${tagColor} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${tagColor} 24%, transparent)`, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", fontWeight: 800 }}
        >
          {isSshAttention ? <RestartIcon size={10} /> : "!"}
        </span>
      )}
      <span
        className="text-ellipsis"
        style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)", flexShrink: 0, maxWidth: "52%" }}
      >
        {displayName}
      </span>
      <span
        className="text-ellipsis"
        style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}
      >
        {session.dir}
      </span>
      {attentionKind === "agent-ready" && fileCount > 0 && (
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
      {isSshAttention ? (
        <AccentActionButton onClick={reconnect} title={t("gbar.action.reconnect")} ariaLabel={t("gbar.action.reconnect")}>
          <RestartIcon size={10} />
          {t("gbar.action.reconnect")}
        </AccentActionButton>
      ) : variant === "resumable" ? (
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
  const groups = useMemo(() => deriveSessionAttention(sessions), [sessions]);

  if (groups.total === 0) return null;

  const liveCount = groups.attention.length + groups.running.length;

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
              count={groups.attention.length}
              color="var(--c-error)"
              label={t("gbar.count.attention", { count: groups.attention.length })}
            />
            <CountChip
              count={groups.running.length}
              color="var(--c-accent)"
              label={t("gbar.count.run", { count: groups.running.length })}
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
              {groups.attention.length > 0 && (
                <div role="group" aria-label={t("gbar.group.attention")}>
                  <GroupLabel label={t("gbar.group.attention")} count={groups.attention.length} accent />
                  {groups.attention.map(({ session, kind }) => (
                    <ActivityRow key={session.id} session={session} variant="attention" attentionKind={kind} onSelect={onSelectSession} />
                  ))}
                </div>
              )}
              {groups.running.length > 0 && (
                <div role="group" aria-label={t("gbar.group.run")}>
                  <GroupLabel label={t("gbar.group.run")} count={groups.running.length} />
                  {groups.running.map((s) => (
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
