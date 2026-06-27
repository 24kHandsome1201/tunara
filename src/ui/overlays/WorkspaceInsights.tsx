import { useMemo, useRef } from "react";
import type React from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { buildFocusQuest, buildWorkspaceInsights, formatWorkspaceDigest, type WorkspaceQuestStep, type WorkspaceSignal } from "@/modules/workspace/insights";
import { useT } from "@/modules/i18n";
import { CloseIcon } from "../shared";
import { useFocusTrap } from "./useFocusTrap";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--c-border-1)",
  borderRadius: "var(--r-card)",
  background: "var(--c-bg-1)",
  boxShadow: "var(--shadow-card)",
};

function RadarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="M12 12l5-5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SmallButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={disabled ? undefined : "hover-bg"}
      style={{
        minHeight: 30,
        border: "1px solid var(--c-border-2)",
        borderRadius: "var(--r-btn)",
        background: disabled ? "var(--c-bg-2)" : "var(--c-bg-white)",
        color: disabled ? "var(--c-text-6)" : "var(--c-text-2)",
        fontSize: "var(--fs-secondary)",
        fontFamily: "var(--font-ui)",
        padding: "0 10px",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
      }}
    >
      {children}
    </button>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div style={{ ...CARD_STYLE, padding: "10px 11px", minWidth: 0 }}>
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, lineHeight: "24px", fontWeight: 750, color: "var(--c-text-primary)", letterSpacing: "-0.02em" }}>{value}</div>
      {hint && <div style={{ marginTop: 4, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</div>}
    </div>
  );
}

function signalText(t: ReturnType<typeof useT>, signal: WorkspaceSignal): { title: string; body: string } {
  return {
    title: t(`workspace.signal.${signal.kind}.title`),
    body: t(`workspace.signal.${signal.kind}.body`, { count: String(signal.count) }),
  };
}

function questText(t: ReturnType<typeof useT>, step: WorkspaceQuestStep): string {
  return t(`workspace.quest.${step.kind}`, { count: String(step.count) });
}

function severityStyle(severity: WorkspaceSignal["severity"]): React.CSSProperties {
  if (severity === "danger") return { color: "var(--c-error)", background: "var(--c-error-bg)", borderColor: "var(--c-error-bg-light)" };
  if (severity === "warning") return { color: "var(--c-warning)", background: "color-mix(in srgb, var(--c-warning) 14%, var(--c-bg-white))", borderColor: "color-mix(in srgb, var(--c-warning) 30%, var(--c-border-1))" };
  if (severity === "success") return { color: "var(--c-success)", background: "var(--c-success-bg-light)", borderColor: "var(--c-success-bg)" };
  return { color: "var(--c-info)", background: "var(--c-info-bg)", borderColor: "color-mix(in srgb, var(--c-info) 28%, var(--c-border-1))" };
}

export function WorkspaceInsights({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const insights = useMemo(() => buildWorkspaceInsights(sessions), [sessions]);
  const quest = useMemo(() => buildFocusQuest(insights), [insights]);
  const completedIds = useMemo(
    () => sessions.filter((s) => s.runState === "done" && !s.unread && s.id !== activeSessionId).map((s) => s.id),
    [sessions, activeSessionId],
  );

  function toast(title: string, subtitle: string, variant: "success" | "error" = "success") {
    const sessionId = activeSession?.id ?? sessions[0]?.id;
    if (!sessionId) return;
    useUIStore.getState().addToast({ sessionId, title, subtitle, variant });
  }

  function refreshAllGit() {
    const st = useSessionsStore.getState();
    let count = 0;
    for (const session of st.sessions) {
      if (session.remote) continue;
      count += 1;
      st.refreshGit(session.id);
    }
    toast(t("workspace.toast.git_refresh.title"), t("workspace.toast.git_refresh.body", { count: String(count) }));
  }

  async function copyDigest() {
    try {
      await navigator.clipboard.writeText(formatWorkspaceDigest(insights));
      toast(t("workspace.toast.copied.title"), t("workspace.toast.copied.body"));
    } catch {
      toast(t("workspace.toast.copy_failed.title"), t("workspace.toast.copy_failed.body"), "error");
    }
  }

  function openInspector(tab: "changes" | "files") {
    const ui = useUIStore.getState();
    ui.setPanelVisible(true);
    ui.setInspectorTab(tab);
    onClose();
  }

  function enterFocusMode() {
    const ui = useUIStore.getState();
    ui.setSidebarVisible(false);
    ui.setPanelVisible(false);
    toast(t("workspace.toast.focus.title"), t("workspace.toast.focus.body"));
    onClose();
  }

  function closeCompletedSessions() {
    if (completedIds.length === 0) return;
    useSessionsStore.getState().closeSessions(completedIds);
    toast(t("workspace.toast.cleanup.title"), t("workspace.toast.cleanup.body", { count: String(completedIds.length) }));
  }

  const stats = insights.stats;
  const canOpenChanges = !!activeSession && !activeSession.remote;
  const intensityBackground = `linear-gradient(90deg, var(--c-accent) ${insights.intensity}%, var(--c-bg-3) ${insights.intensity}%)`;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 999,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("workspace.title")}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 760,
          maxWidth: "92vw",
          maxHeight: "82vh",
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-border-2)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 34, height: 34, borderRadius: "var(--r-card)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-accent)", background: "var(--c-accent-bg-soft)", border: "1px solid var(--c-accent-border)" }}>
            <RadarIcon size={18} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 17, letterSpacing: "-0.02em", color: "var(--c-text-primary)" }}>{t("workspace.title")}</h2>
              <span style={{ borderRadius: "var(--r-pill)", background: "var(--c-accent-bg-soft)", color: "var(--c-accent)", border: "1px solid var(--c-accent-border)", padding: "2px 7px", fontSize: "var(--fs-meta)", fontWeight: 700 }}>
                {t(`workspace.mood.${insights.mood}`)}
              </span>
            </div>
            <div style={{ marginTop: 3, fontSize: "var(--fs-secondary)", color: "var(--c-text-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t("workspace.subtitle", { name: insights.codename })}
            </div>
          </div>
          <button
            onClick={onClose}
            title={t("common.close")}
            className="hover-bg"
            style={{ width: 28, height: 28, border: "none", background: "transparent", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--c-text-4)" }}
          >
            <CloseIcon size={14} strokeWidth={2.2} />
          </button>
        </div>

        <div className="scroll-fade-y" style={{ flex: 1, overflowY: "auto", padding: 18, background: "var(--c-bg-2-glass)" }}>
          <div style={{ ...CARD_STYLE, padding: 14, marginBottom: 14, background: "var(--c-bg-white)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 2 }}>{t("workspace.intensity")}</div>
                <div style={{ fontSize: 24, lineHeight: "28px", fontWeight: 780, color: "var(--c-text-primary)", letterSpacing: "-0.03em" }}>{insights.intensity}/100</div>
              </div>
              <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)", maxWidth: 420, textAlign: "right" }}>
                {t("workspace.intensity_hint")}
              </div>
            </div>
            <div style={{ height: 8, borderRadius: "var(--r-pill)", background: intensityBackground, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--c-text-primary) 5%, transparent)" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
            <StatCard label={t("workspace.metric.sessions")} value={stats.totalSessions} hint={t("workspace.metric.sessions_hint", { count: String(stats.runningSessions) })} />
            <StatCard label={t("workspace.metric.agents")} value={stats.agentSessions} hint={t("workspace.metric.agents_hint", { count: String(stats.busyAgents) })} />
            <StatCard label={t("workspace.metric.changes")} value={stats.changedFiles} hint={`+${stats.addedLines} / -${stats.removedLines}`} />
            <StatCard label={t("workspace.metric.remote")} value={stats.remoteSessions} hint={t("workspace.metric.remote_hint", { count: String(stats.localSessions) })} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)", gap: 14 }}>
            <section style={{ ...CARD_STYLE, padding: 14, background: "var(--c-bg-white)" }}>
              <h3 style={{ margin: "0 0 10px", fontSize: "var(--fs-body)", color: "var(--c-text-primary)" }}>{t("workspace.signals")}</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {insights.signals.map((signal) => {
                  const text = signalText(t, signal);
                  const badgeStyle = severityStyle(signal.severity);
                  return (
                    <div key={signal.kind} style={{ border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", padding: 10, display: "flex", gap: 10, alignItems: "flex-start", background: "var(--c-bg-1)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: "var(--r-pill)", border: "1px solid", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--fs-meta)", fontWeight: 800, ...badgeStyle }}>
                        {signal.count}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: "var(--fs-secondary)", fontWeight: 700, color: "var(--c-text-primary)" }}>{text.title}</div>
                        <div style={{ marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", lineHeight: 1.5 }}>{text.body}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section style={{ ...CARD_STYLE, padding: 14, background: "var(--c-bg-white)", display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <h3 style={{ margin: "0 0 5px", fontSize: "var(--fs-body)", color: "var(--c-text-primary)" }}>{t("workspace.quest.title")}</h3>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", lineHeight: 1.5 }}>{t("workspace.quest.hint")}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {quest.map((step) => (
                  <div key={step.kind} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: "var(--r-card)", background: step.completed ? "var(--c-success-bg-light)" : "var(--c-bg-1)", border: `1px solid ${step.completed ? "var(--c-success-bg)" : "var(--c-border-1)"}` }}>
                    <span style={{ width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: step.completed ? "var(--c-success)" : "var(--c-accent-bg-soft)", color: step.completed ? "white" : "var(--c-accent)", fontSize: "var(--fs-meta)", fontWeight: 800 }}>
                      {step.completed ? "✓" : "•"}
                    </span>
                    <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", lineHeight: 1.45 }}>{questText(t, step)}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        <div style={{ padding: "12px 14px", borderTop: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "var(--c-bg-white)" }}>
          <SmallButton onClick={copyDigest}>{t("workspace.action.copy_digest")}</SmallButton>
          <SmallButton onClick={refreshAllGit} disabled={stats.localSessions === 0}>{t("workspace.action.refresh_git")}</SmallButton>
          <SmallButton onClick={() => openInspector("changes")} disabled={!canOpenChanges}>{t("workspace.action.open_changes")}</SmallButton>
          <SmallButton onClick={() => openInspector("files")} disabled={!activeSession}>{t("workspace.action.open_files")}</SmallButton>
          <SmallButton onClick={enterFocusMode}>{t("workspace.action.focus")}</SmallButton>
          <span style={{ flex: 1 }} />
          <SmallButton onClick={closeCompletedSessions} disabled={completedIds.length === 0}>{t("workspace.action.cleanup", { count: String(completedIds.length) })}</SmallButton>
        </div>
      </div>
    </>
  );
}
