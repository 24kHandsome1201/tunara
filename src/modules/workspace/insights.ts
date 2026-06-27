import type { Session } from "../../ui/types.ts";

export type WorkspaceMood = "calm" | "active" | "review" | "hot";
export type WorkspaceSignalSeverity = "success" | "info" | "warning" | "danger";

export type WorkspaceSignalKind =
  | "calm"
  | "agents_running"
  | "review_changes"
  | "unread_sessions"
  | "remote_sessions"
  | "cleanup_finished";

export type WorkspaceQuestStepKind =
  | "watch_agents"
  | "review_changes"
  | "clear_unread"
  | "clean_finished"
  | "check_remote"
  | "enjoy_calm";

export interface WorkspaceInsightStats {
  totalSessions: number;
  localSessions: number;
  remoteSessions: number;
  runningSessions: number;
  doneSessions: number;
  staleDoneSessions: number;
  agentSessions: number;
  busyAgents: number;
  unreadSessions: number;
  changedFiles: number;
  changedRepos: number;
  addedLines: number;
  removedLines: number;
}

export interface WorkspaceSignal {
  kind: WorkspaceSignalKind;
  severity: WorkspaceSignalSeverity;
  count: number;
  sessionIds: string[];
}

export interface WorkspaceQuestStep {
  kind: WorkspaceQuestStepKind;
  count: number;
  completed: boolean;
}

export interface WorkspaceInsights {
  mood: WorkspaceMood;
  intensity: number;
  codename: string;
  stats: WorkspaceInsightStats;
  signals: WorkspaceSignal[];
}

const STALE_DONE_SESSION_MS = 30 * 60 * 1000;
const CODENAME_ADJECTIVES = ["Copper", "Velvet", "Orbit", "Quiet", "Neon", "Lucky", "Pocket", "Solar"] as const;
const CODENAME_NOUNS = ["Otter", "Comet", "Forge", "Harbor", "Mango", "Lantern", "Tuna", "Nimbus"] as const;

function sessionIsRunning(session: Session): boolean {
  return session.runState === "running" || session.agentActivity === "running" || session.agentActivity === "starting";
}

function sessionHasChanges(session: Session): boolean {
  return !session.remote && (session.changes?.files.length ?? 0) > 0;
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildCodename(sessions: Session[]): string {
  const seed = sessions.length > 0
    ? sessions.map((s) => `${s.dir}:${s.agent ?? "sh"}`).sort().join("|")
    : "empty-workspace";
  const hash = stableHash(seed);
  const adjective = CODENAME_ADJECTIVES[hash % CODENAME_ADJECTIVES.length];
  const noun = CODENAME_NOUNS[Math.floor(hash / CODENAME_ADJECTIVES.length) % CODENAME_NOUNS.length];
  return `${adjective} ${noun}`;
}

function clampIntensity(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildMood(stats: WorkspaceInsightStats, intensity: number): WorkspaceMood {
  if (stats.busyAgents > 0 || stats.runningSessions >= 3 || intensity >= 70) return "hot";
  if (stats.changedFiles > 0) return "review";
  if (stats.runningSessions > 0 || stats.totalSessions > 1 || stats.remoteSessions > 0) return "active";
  return "calm";
}

function pushSignal(
  signals: WorkspaceSignal[],
  kind: WorkspaceSignalKind,
  severity: WorkspaceSignalSeverity,
  sessions: Session[],
) {
  if (sessions.length === 0) return;
  signals.push({
    kind,
    severity,
    count: sessions.length,
    sessionIds: sessions.map((s) => s.id),
  });
}

export function buildWorkspaceInsights(sessions: Session[], now = Date.now()): WorkspaceInsights {
  const remoteSessions = sessions.filter((s) => !!s.remote);
  const runningSessions = sessions.filter(sessionIsRunning);
  const doneSessions = sessions.filter((s) => s.runState === "done");
  const staleDoneSessions = doneSessions.filter((s) => {
    if (typeof s.completedAt !== "number") return false;
    return now - s.completedAt >= STALE_DONE_SESSION_MS;
  });
  const agentSessions = sessions.filter((s) => !!s.agent);
  const busyAgentSessions = sessions.filter((s) => s.agentActivity === "running" || s.agentActivity === "starting");
  const unreadSessions = sessions.filter((s) => !!s.unread);
  const changedSessions = sessions.filter(sessionHasChanges);
  const changedRepoDirs = new Set(changedSessions.map((s) => s.dir));

  let changedFiles = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (const session of changedSessions) {
    const files = session.changes?.files ?? [];
    changedFiles += files.length;
    for (const file of files) {
      addedLines += Math.max(0, file.added ?? 0);
      removedLines += Math.max(0, file.removed ?? 0);
    }
  }

  const stats: WorkspaceInsightStats = {
    totalSessions: sessions.length,
    localSessions: sessions.length - remoteSessions.length,
    remoteSessions: remoteSessions.length,
    runningSessions: runningSessions.length,
    doneSessions: doneSessions.length,
    staleDoneSessions: staleDoneSessions.length,
    agentSessions: agentSessions.length,
    busyAgents: busyAgentSessions.length,
    unreadSessions: unreadSessions.length,
    changedFiles,
    changedRepos: changedRepoDirs.size,
    addedLines,
    removedLines,
  };

  const intensity = clampIntensity(
    stats.runningSessions * 18
    + stats.busyAgents * 22
    + stats.changedRepos * 16
    + stats.unreadSessions * 10
    + Math.min(24, Math.floor(stats.changedFiles / 2))
    + Math.min(8, stats.remoteSessions * 3),
  );

  const signals: WorkspaceSignal[] = [];
  pushSignal(signals, "agents_running", "info", busyAgentSessions);
  pushSignal(signals, "review_changes", stats.changedFiles >= 20 ? "danger" : "warning", changedSessions);
  pushSignal(signals, "unread_sessions", "warning", unreadSessions);
  pushSignal(signals, "remote_sessions", "info", remoteSessions);
  pushSignal(signals, "cleanup_finished", "success", staleDoneSessions);
  if (signals.length === 0) {
    signals.push({ kind: "calm", severity: "success", count: 1, sessionIds: [] });
  }

  return {
    mood: buildMood(stats, intensity),
    intensity,
    codename: buildCodename(sessions),
    stats,
    signals,
  };
}

export function buildFocusQuest(insights: WorkspaceInsights): WorkspaceQuestStep[] {
  const { stats } = insights;
  const steps: WorkspaceQuestStep[] = [];

  if (stats.busyAgents > 0) steps.push({ kind: "watch_agents", count: stats.busyAgents, completed: false });
  if (stats.changedFiles > 0) steps.push({ kind: "review_changes", count: stats.changedFiles, completed: false });
  if (stats.unreadSessions > 0) steps.push({ kind: "clear_unread", count: stats.unreadSessions, completed: false });
  if (stats.staleDoneSessions > 0) steps.push({ kind: "clean_finished", count: stats.staleDoneSessions, completed: false });
  if (stats.remoteSessions > 0) steps.push({ kind: "check_remote", count: stats.remoteSessions, completed: false });

  if (steps.length === 0) return [{ kind: "enjoy_calm", count: 1, completed: true }];
  return steps.slice(0, 4);
}

export function formatWorkspaceDigest(insights: WorkspaceInsights): string {
  const { stats } = insights;
  return [
    `Workspace ${insights.codename}`,
    `Mood: ${insights.mood}`,
    `Intensity: ${insights.intensity}/100`,
    `Sessions: ${stats.totalSessions} total, ${stats.runningSessions} running, ${stats.remoteSessions} remote`,
    `Agents: ${stats.agentSessions} detected, ${stats.busyAgents} busy`,
    `Changes: ${stats.changedFiles} files across ${stats.changedRepos} repos, +${stats.addedLines}/-${stats.removedLines}`,
    `Unread: ${stats.unreadSessions}`,
  ].join("\n");
}
