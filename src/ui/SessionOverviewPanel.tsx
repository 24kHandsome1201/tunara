import type React from "react";
import { AGENT_NAMES, deriveTitle, type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { isSessionBusy, sessionDisplayRunState } from "@/modules/terminal/lib/agent-lifecycle";
import { summarizeChangedFiles } from "@/modules/session/session-insights";
import { getSessionNoteStats } from "@/modules/session/session-notes";
import { openInEditor } from "@/modules/editor/open";
import { useT } from "@/modules/i18n";

interface SessionOverviewPanelProps {
  session: Session;
}

function InfoCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        border: "1px solid var(--c-border-1)",
        background: "var(--c-bg-white)",
        borderRadius: "var(--r-card)",
        padding: "10px 12px",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-primary)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hint}>
          {hint}
        </div>
      )}
    </div>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="hover-bg"
      style={{
        height: 30,
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        background: "var(--c-bg-white)",
        color: "var(--c-text-primary)",
        cursor: "pointer",
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
  if (isSessionBusy(session)) return t("overview.status.running");
  const state = sessionDisplayRunState(session);
  if (state === "done") return t("overview.status.done");
  if (state === "failed") return t("overview.status.failed");
  return t("overview.status.idle");
}

export function SessionOverviewPanel({ session }: SessionOverviewPanelProps) {
  const t = useT();
  const externalEditor = useUIStore((s) => s.externalEditor);
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

  const openNotes = () => {
    useUIStore.getState().setPanelVisible(true);
    useUIStore.getState().setInspectorTab("notes");
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 14 }} className="no-scrollbar scroll-fade-y">
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {session.pinned && <span style={{ color: "var(--c-accent)", flexShrink: 0 }}>★</span>}
          <div style={{ fontSize: 16, fontWeight: 750, color: "var(--c-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={primary}>
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
        <InfoCard label={t("overview.card.status")} value={statusLabel(session, t)} hint={session.lastExitCode !== undefined ? `exit ${session.lastExitCode}` : undefined} />
        <InfoCard label={t("overview.card.agent")} value={agentName} hint={session.agentActivity ? t(`overview.agent_activity.${session.agentActivity}`) : undefined} />
        <InfoCard label={isRemote ? t("overview.card.remote") : t("overview.card.cwd")} value={isRemote ? remoteLabel : session.dir} />
        <InfoCard label={t("overview.card.changes")} value={changes.fileCount > 0 ? t("overview.changes.files", { count: String(changes.fileCount) }) : changeHint} hint={changes.fileCount > 0 ? changeHint : undefined} />
      </div>

      {session.lastCommand && (
        <div style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: 12 }}>
          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 6 }}>{t("overview.last_command")}</div>
          <code style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {session.lastCommand}
          </code>
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
        <ActionButton onClick={() => navigator.clipboard?.writeText(session.dir).catch(() => {})}>
          {t("overview.action.copy_path")}
        </ActionButton>
        {!isRemote && (
          <ActionButton onClick={() => useSessionsStore.getState().newTerminalInDir(session.dir)}>
            {t("overview.action.new_terminal_here")}
          </ActionButton>
        )}
        {!isRemote && (
          <ActionButton onClick={() => openInEditor(externalEditor, session.dir).catch(() => {})}>
            {t("overview.action.open_in_editor")}
          </ActionButton>
        )}
        {!isRemote && (
          <ActionButton onClick={() => useSessionsStore.getState().refreshGit(session.id)}>
            {t("overview.action.refresh_git")}
          </ActionButton>
        )}
      </div>
    </div>
  );
}
