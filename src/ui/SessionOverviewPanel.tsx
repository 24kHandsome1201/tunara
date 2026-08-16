import { useSyncExternalStore } from "react";
import type React from "react";
import { AGENT_NAMES, deriveTitle, reconnectPrefillFromSession, type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";
import { summarizeChangedFiles } from "@/modules/session/session-insights";
import { getSessionNoteStats } from "@/modules/session/session-notes";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";
import { formatTimelineRelativeTime, type TimelineEvent } from "@/state/timeline";
import { SessionMascotIcon } from "./SessionMascotIcon";
import { SessionMascotPicker } from "./SessionMascotPicker";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { SessionRemediationNotice } from "./SessionRemediationNotice";
import { diagnosticReportText } from "@/modules/ssh/diagnostics-bridge";
import { diagnosticsCenter, diagnosticsForSession } from "@/modules/ssh/diagnostics-store";
import { CloseIcon } from "./shared";

interface SessionOverviewPanelProps {
  session: Session;
}

const EMPTY_TIMELINE: readonly TimelineEvent[] = Object.freeze([]);

function InfoCard({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-primary)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hint}>
          {hint}
        </div>
      )}
    </>
  );
  const style = {
    minWidth: 0,
    border: "1px solid var(--c-border-1)",
    background: "var(--c-bg-white)",
    borderRadius: "var(--r-card)",
    padding: "10px 12px",
    boxShadow: "var(--shadow-card)",
    textAlign: "left" as const,
  };
  if (!onClick) return <div style={style}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover-bg"
      style={{ ...style, cursor: "pointer", font: "inherit", color: "inherit" }}
    >
      {body}
    </button>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="ui-button"
      style={{
        height: 30,
        padding: "0 10px",
        fontSize: "var(--fs-secondary)",
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      {children}
    </button>
  );
}

function statusLabel(session: Session, t: ReturnType<typeof useT>): string {
  if (session.connection && session.connection.phase !== "ready") {
    return t(`connection.phase.${session.connection.phase}`);
  }
  if (isSessionBusy(session)) return t("overview.status.running");
  const state = sessionDisplayRunState(session);
  if (state === "done") return t("overview.status.done");
  if (state === "failed") return t("overview.status.failed");
  return t("overview.status.idle");
}

function timelineLabel(event: TimelineEvent, t: ReturnType<typeof useT>): string {
  const base = t(`overview.timeline.${event.type}`);
  return event.detail ? `${base} · ${event.detail}` : base;
}

export function SessionOverviewPanel({ session }: SessionOverviewPanelProps) {
  const t = useT();
  const externalEditor = useUIStore((s) => s.externalEditor);
  const shellIntegrationHintDismissed = useUIStore((s) => s.shellIntegrationHintDismissed);
  const timeline = useSessionsStore((s) => s.sessionTimelines[session.id] ?? EMPTY_TIMELINE);
  const { primary, subtitle } = deriveTitle(session);
  const changes = summarizeChangedFiles(session.changes?.files);
  const noteStats = getSessionNoteStats(session.note ?? "");
  const isRemote = !!session.remote;
  const agentName = session.agent ? AGENT_NAMES[session.agent] ?? session.agent : t("overview.agent.none");
  const remoteLabel = session.remote
    ? `${session.remote.user}@${session.remote.host}${session.remote.port !== 22 ? `:${session.remote.port}` : ""}`
    : t("overview.remote.local");
  const changeHint = changes.fileCount > 0
    ? `+${changes.added} / -${changes.removed}`
    : session.gitState === "notGit"
      ? t("overview.changes.not_git")
      : t("overview.changes.clean");
  const connectionHint = session.connection
    ? `${session.connection.phase === "ready" ? `${t("connection.phase.ready")} · ` : ""}${t(`connection.source.${session.connection.source}`)} · ${formatTimelineRelativeTime(session.connection.updatedAt)}`
    : undefined;
  const currentWorktree = currentWorkspaceWorktree(session.workspace);
  useSyncExternalStore(diagnosticsCenter.subscribe, diagnosticsCenter.snapshot);
  const diagnosticEvents = diagnosticsForSession(session.id);
  const connectionAbnormal = !!session.connection && session.connection.phase !== "ready";
  const showShellIntegrationHint = !session.agent
    && Boolean(session.lastCommand)
    && !session.shellIntegrationSeen
    && !shellIntegrationHintDismissed;

  const openInspector = (tab: "changes" | "files" | "notes") => {
    useUIStore.getState().setPanelVisible(true);
    useUIStore.getState().setInspectorTab(tab);
  };

  const openNotes = () => openInspector("notes");

  const copyDiagnostics = async () => {
    const copied = await copyText(diagnosticReportText(session.id));
    useUIStore.getState().addToast({
      sessionId: session.id,
      title: t(copied ? "diagnostics.copy_succeeded" : "diagnostics.copy_failed"),
      subtitle: "",
      variant: copied ? "success" : "error",
    });
  };

  const reconnectRemote = () => {
    if (!session.remote) return;
    useUIStore.getState().openSshConnect(reconnectPrefillFromSession(session));
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }} className="no-scrollbar scroll-fade-y">
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {session.mascot && <SessionMascotIcon id={session.mascot} size={30} />}
          {session.pinned && <span style={{ color: "var(--c-accent)", flexShrink: 0 }}>★</span>}
          <div style={{ fontSize: "var(--fs-title)", fontWeight: 750, color: "var(--c-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={primary}>
            {primary}
          </div>
        </div>
        {subtitle && (
          <div style={{ marginTop: 4, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={subtitle}>
            {subtitle}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        <InfoCard label={t("overview.card.status")} value={statusLabel(session, t)} hint={connectionHint ?? (session.lastExitCode !== undefined ? t("overview.card.exit_code", { code: session.lastExitCode }) : undefined)} />
        <InfoCard label={t("overview.card.agent")} value={agentName} hint={session.agentActivity ? t(`overview.agent_activity.${session.agentActivity}`) : undefined} />
        <InfoCard label={isRemote ? t("overview.card.remote") : t("overview.card.cwd")} value={isRemote ? remoteLabel : session.dir} onClick={() => openInspector("files")} />
        <InfoCard label={t("overview.card.changes")} value={changes.fileCount > 0 ? t("overview.changes.files", { count: String(changes.fileCount) }) : changeHint} hint={changes.fileCount > 0 ? changeHint : undefined} onClick={() => openInspector("changes")} />
      </div>

      <SessionMascotPicker session={session} />

      <SessionRemediationNotice session={session} />

      {showShellIntegrationHint && (
        <div role="status" style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: "9px 11px", display: "flex", gap: 8, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1, color: "var(--c-text-4)", fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>
            <strong style={{ color: "var(--c-text-2)" }}>{t("overview.shell_integration.title")}</strong>
            <span> · {t("overview.shell_integration.body")}</span>
          </div>
          <button
            type="button"
            className="hover-bg"
            onClick={() => useUIStore.getState().dismissShellIntegrationHint()}
            aria-label={t("overview.shell_integration.dismiss")}
            title={t("overview.shell_integration.dismiss")}
            style={{ width: 22, height: 22, flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {isRemote && connectionAbnormal && diagnosticEvents.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <ActionButton onClick={() => { void copyDiagnostics(); }}>
            {t("overview.action.copy_diagnostics")}
          </ActionButton>
        </div>
      )}

      {session.workspaceState === "unavailable" && (
        <div role="status" style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: "9px 11px", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>
          <strong style={{ color: "var(--c-error)" }}>{t("workspace.unavailable")}</strong>
          <span> · {t("workspace.unavailable_hint")}</span>
        </div>
      )}

      {session.workspace && currentWorktree && (
        <section
          aria-label={t("workspace.title")}
          style={{
            marginBottom: 12,
            border: "1px solid var(--c-border-1)",
            borderRadius: "var(--r-card)",
            background: "var(--c-bg-white)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "10px 12px", borderBottom: session.workspace.worktrees.length > 1 ? "1px solid var(--c-border-1)" : undefined }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("workspace.title")}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
                {session.workspace.repository.transport === "ssh" ? t("workspace.ssh") : t("workspace.local")}
              </span>
            </div>
            <div style={{ marginTop: 5, display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
              <strong style={{ fontSize: "var(--fs-body)", color: "var(--c-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {session.workspace.repository.name}
              </strong>
              <span style={{ color: "var(--c-text-6)" }}>/</span>
              <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={currentWorktree.path}>
                {currentWorktree.name}
              </span>
            </div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
              <span>{currentWorktree.detached ? t("workspace.detached") : `⎇ ${currentWorktree.branch ?? t("workspace.unknown_branch")}`}</span>
              {(currentWorktree.ahead ?? 0) > 0 && <span>↑{currentWorktree.ahead}</span>}
              {(currentWorktree.behind ?? 0) > 0 && <span>↓{currentWorktree.behind}</span>}
              <span style={{ color: currentWorktree.dirtyFiles === undefined ? "var(--c-text-5)" : currentWorktree.dirtyFiles > 0 ? "var(--c-warning)" : "var(--c-success)" }}>
                {currentWorktree.dirtyFiles === undefined
                  ? t("workspace.dirty_unknown")
                  : currentWorktree.dirtyFiles > 0
                  ? t("workspace.dirty_files", { count: String(currentWorktree.dirtyFiles) })
                  : t("workspace.clean")}
              </span>
            </div>
          </div>

          {session.workspace.worktrees.length > 1 && (
            <div style={{ padding: "8px 12px 10px" }}>
              <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 6 }}>
                {t("workspace.other_worktrees", { count: String(session.workspace.worktrees.length - 1) })}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {session.workspace.worktrees.filter((worktree) => !worktree.current).map((worktree) => (
                  <div key={worktree.id} title={worktree.error ?? worktree.path} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: "var(--fs-meta)" }}>
                    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: !worktree.available ? "var(--c-error)" : worktree.dirtyFiles === undefined ? "var(--c-text-6)" : worktree.dirtyFiles > 0 ? "var(--c-warning)" : "var(--c-text-6)", flexShrink: 0 }} />
                    <span style={{ color: "var(--c-text-3)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {worktree.name}
                    </span>
                    <span style={{ color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                      {worktree.detached ? t("workspace.detached_short") : worktree.branch ?? t("workspace.unknown_branch")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {session.lastCommand && (
        <div style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: 12 }}>
          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 6 }}>{t("overview.last_command")}</div>
          <code style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {session.lastCommand}
          </code>
        </div>
      )}

      {timeline.length > 0 && (
        <div style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: 12 }}>
          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 8 }}>{t("overview.timeline.title")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {timeline.slice(0, 12).map((event) => (
              <div key={event.id} style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 28 }}>
                  {formatTimelineRelativeTime(event.at)}
                </span>
                <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={event.detail ?? timelineLabel(event, t)}>
                  {timelineLabel(event, t)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <ActionButton onClick={() => useSessionsStore.getState().togglePinnedSession(session.id)}>
          {session.pinned ? t("overview.action.unpin") : t("overview.action.pin")}
        </ActionButton>
        <ActionButton onClick={openNotes}>
          {noteStats.todoCount > 0
            ? t("overview.action.notes_with_todos", { done: String(noteStats.doneCount), total: String(noteStats.todoCount) })
            : t("overview.action.open_notes")}
        </ActionButton>
        <ActionButton onClick={() => void copyText(session.dir)}>
          {t("overview.action.copy_path")}
        </ActionButton>
        {!isRemote && (
          <ActionButton onClick={() => useSessionsStore.getState().newTerminalInDir(session.dir)}>
            {t("overview.action.new_terminal_here")}
          </ActionButton>
        )}
        {!isRemote && (
          <ActionButton onClick={() => { void openInEditorWithToast(externalEditor, session.dir, { sessionId: session.id }); }}>
            {t("overview.action.open_in_editor")}
          </ActionButton>
        )}
        {!isRemote && (
          <ActionButton onClick={() => useSessionsStore.getState().refreshGit(session.id)}>
            {t("overview.action.refresh_git")}
          </ActionButton>
        )}
        {isRemote && session.connection && ["disconnected", "failed", "exited"].includes(session.connection.phase) && (
          <ActionButton onClick={reconnectRemote}>
            {t("terminal.exited.reconnect")}
          </ActionButton>
        )}
      </div>
    </div>
  );
}
