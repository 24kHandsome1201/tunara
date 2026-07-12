import { create } from "zustand";
import type { Session, AgentCode, RemoteInfo, SshConnectSuggestion } from "@/ui/types";
import { AGENT_NAMES } from "@/ui/types";
import { initialAgentActivity, isSessionBusy } from "@/modules/terminal/lib/agent-lifecycle";
import {
  buildAgentResumeIntent,
  reconcileAgentResumeIntent,
  resolveAgentResumeSourceCommand,
} from "@/modules/terminal/lib/agent-resume";
import { t } from "@/modules/i18n/core.ts";
import {
  agentBusyUpdate,
  agentDetectedUpdate,
  agentExitedUpdate,
  agentReadyUpdate,
  agentWaitingConfirmationUpdate,
  commandDetectedUpdate,
  commandFinishedUpdate,
  cwdChangedUpdate,
  shellTitleUpdate,
  terminalExitedUpdate,
  terminalProgressUpdate,
} from "@/modules/terminal/lib/session-lifecycle";
import { useUIStore } from "./ui";
import { pushRecentDir } from "./recent-dirs";
import { pushRecentCommand } from "./recent-commands";
import { sanitizeSessionNote } from "@/modules/session/session-notes";
import { localTerminalCwdFromSession, splitTerminalContextFromSession } from "@/modules/session/local-terminal-cwd";
import { requestDirtyDraftAction } from "@/modules/editor/dirty-draft-guard";
import { removeTerminalSnapshot } from "@/modules/terminal/lib/terminal-snapshot";
import { getNumberRecordValue } from "@/state/record-keys";
import {
  appendTimelineEvent,
  createTimelineEvent,
  shouldRecordGitChange,
  type TimelineEvent,
} from "./timeline";
import {
  cancelPendingGitRefresh,
  clearQueuedGitNonceBump,
  scheduleGitRefresh,
} from "./sessions-git";
import { clearSshCredentials } from "@/modules/ssh/pending-credentials";
import {
  initialConnectionEvidence,
  reduceConnectionEvidence,
  type ConnectionEvent,
} from "@/modules/terminal/lib/connection-state";
import {
  detectPreviewSources,
  markPreviewSourcesStale,
  mergePreviewSources,
  previewSourceContext,
} from "@/modules/preview/preview-source";

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  renamingSessionId: string | null;
  launchedSessionIds: Record<string, true>;
  gitNonce: Record<string, number>;
  closeConfirmations: Record<string, number>;
  dirCloseConfirmations: Record<string, number>;
  recentDirs: string[];
  recentCommands: string[];
  // Session ids in most-recently-active-first order, used by Mod+Tab cycling.
  recentSessionIds: string[];
  sessionTimelines: Record<string, TimelineEvent[]>;

  addSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  cycleSession: (direction: "next" | "prev") => void;
  markRead: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  refreshGit: (id: string) => void;
  clearCloseConfirmation: (id: string) => void;
  closeSessions: (ids: string[], opts?: { toastSubtitle?: string }) => boolean;
  closeSessionsInDir: (dir: string) => void;
  clearDirCloseConfirmation: (dir: string) => void;
  recordRecentDir: (dir: string) => void;
  recordRecentCommand: (command: string) => void;
  togglePinnedSession: (id: string) => void;
  setSessionNote: (id: string, note: string) => void;
  appendTimeline: (id: string, type: TimelineEvent["type"], detail?: string) => void;
  handleConnectionEvent: (id: string, event: ConnectionEvent) => void;

  handleAgentDetected: (id: string, agent: AgentCode, command?: string) => void;
  recordAgentSessionId: (id: string, agent: AgentCode, agentSessionId: string) => void;
  handleAgentReady: (id: string) => void;
  handleAgentWaitingConfirmation: (id: string) => void;
  handleAgentBusy: (id: string) => void;
  handleAgentExited: (id: string, exitCode: number) => void;
  handleCommandDetected: (id: string, command: string) => void;
  handleCommandFinished: (id: string, exitCode: number) => void;
  handleTerminalExited: (id: string, exitCode: number) => void;
  handleTerminalOutput: (id: string, output: string, discoveredAt?: number) => void;
  handleCwdChange: (id: string, cwd: string) => void;
  suggestSshConnect: (id: string, target: SshConnectSuggestion) => void;
  clearSshSuggestion: (id: string) => void;
  dismissSshSuggestion: (id: string) => void;
  handleShellTitle: (id: string, title: string) => void;
  handleTerminalProgress: (id: string, progress: Session["terminalProgress"] | undefined) => void;

  renameSession: (id: string, name: string) => void;
  startRenaming: (id: string) => void;
  stopRenaming: () => void;
  reorderInGroup: (dir: string, fromIndex: number, toIndex: number) => void;
  newTerminal: () => void;
  newTerminalInDir: (dir: string) => void;
  newTerminalWithInput: (input: string, dir?: string) => void;
  splitWithNewSession: (direction: "horizontal" | "vertical") => void;
  closeSession: (id: string) => void;
}

let nextId = 1;
const CLOSE_CONFIRM_WINDOW_MS = 3_000;
const closeConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirCloseConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();

export {
  bumpGitNonce,
  cancelPendingGitRefresh,
  clearQueuedGitNonceBump,
  flushGitNonceBumps,
  GIT_REFRESH_THROTTLE_MS,
  scheduleGitRefresh,
} from "./sessions-git";

export function makeSessionId(): string {
  return `s-${Date.now()}-${nextId++}`;
}

export function createSession(
  dir: string,
  opts?: {
    agent?: AgentCode;
    title?: string;
    branch?: string;
    pendingInput?: string;
    pendingInputSubmit?: boolean;
    remote?: RemoteInfo;
  },
): Session {
  const id = makeSessionId();
  const now = Date.now();
  return {
    id,
    agent: opts?.agent,
    agentActivity: opts?.agent ? initialAgentActivity(opts.agent) : undefined,
    title: opts?.title ?? t("session.default_title"),
    dir,
    branch: opts?.branch ?? "",
    gitState: "unknown",
    runState: "idle" as const,
    connection: initialConnectionEvidence(opts?.remote ? "ssh" : "local", "user", now),
    pendingInput: opts?.pendingInput,
    pendingInputSubmit: opts?.pendingInputSubmit,
    remote: opts?.remote,
    updatedAt: now,
  };
}

/**
 * 远程 SSH 会话的 dir 显示为 user@host，且不参与本地 git/文件操作。
 * 真实远程 cwd 由 Phase 4 的远程 shell 集成提供（若启用）。
 */
export function createRemoteSession(remote: RemoteInfo, title?: string): Session {
  const label = `${remote.user}@${remote.host}`;
  return createSession(label, { title: title ?? label, remote });
}

function isSessionObserved(activeSessionId: string | null, sessionId: string): boolean {
  return activeSessionId === sessionId
    && (typeof document === "undefined" || document.hasFocus());
}

function ensureSessionVisibleInSplit(sessionId: string) {
  const ui = useUIStore.getState();
  const { split } = ui;
  if (split.mode === "single" || split.paneA === sessionId || split.paneB === sessionId) return;
  ui.setSplitPaneB(sessionId);
}

function cancelCloseConfirmationTimer(id: string) {
  const timer = closeConfirmationTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  closeConfirmationTimers.delete(id);
}

function cancelDirCloseConfirmationTimer(dir: string) {
  const timer = dirCloseConfirmationTimers.get(dir);
  if (!timer) return;
  clearTimeout(timer);
  dirCloseConfirmationTimers.delete(dir);
}

function scheduleCloseConfirmationExpiry(id: string, clear: (id: string) => void) {
  cancelCloseConfirmationTimer(id);
  const timer = setTimeout(() => {
    closeConfirmationTimers.delete(id);
    clear(id);
  }, CLOSE_CONFIRM_WINDOW_MS);
  closeConfirmationTimers.set(id, timer);
}

function scheduleDirCloseConfirmationExpiry(dir: string, clear: (dir: string) => void) {
  cancelDirCloseConfirmationTimer(dir);
  const timer = setTimeout(() => {
    dirCloseConfirmationTimers.delete(dir);
    clear(dir);
  }, CLOSE_CONFIRM_WINDOW_MS);
  dirCloseConfirmationTimers.set(dir, timer);
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  renamingSessionId: null,
  launchedSessionIds: {},
  gitNonce: {},
  closeConfirmations: {},
  dirCloseConfirmations: {},
  recentDirs: [],
  recentCommands: [],
  recentSessionIds: [],
  sessionTimelines: {},

  addSession: (s) => {
    set((state) => ({
      sessions: [...state.sessions, s],
      activeSessionId: s.id,
      launchedSessionIds: { ...state.launchedSessionIds, [s.id]: true },
      // Remote sessions' dir is "user@host", not a local path — keep it out
      // of the recent-dirs affordance.
      recentDirs: s.remote ? state.recentDirs : pushRecentDir(state.recentDirs, s.dir),
    }));
    ensureSessionVisibleInSplit(s.id);
  },

  removeSession: (id) => {
    if (!requestDirtyDraftAction([id], () => get().removeSession(id))) return;
    cancelCloseConfirmationTimer(id);
    cancelPendingGitRefresh(id);
    // A bump queued in this same tick would otherwise re-create the session's
    // gitNonce key after the store entry below is deleted.
    clearQueuedGitNonceBump(id);
    removeTerminalSnapshot(id);
    clearSshCredentials(id);
    set((state) => {
      const removedIndex = state.sessions.findIndex((s) => s.id === id);
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[Math.min(Math.max(removedIndex, 0), sessions.length - 1)]?.id ?? null
          : state.activeSessionId;
      const { [id]: _removed, ...closeConfirmations } = state.closeConfirmations;
      const { [id]: _launched, ...launchedSessionIds } = state.launchedSessionIds;
      const { [id]: _gitNonce, ...gitNonce } = state.gitNonce;
      const { [id]: _timeline, ...sessionTimelines } = state.sessionTimelines;
      const nextLaunchedSessionIds = { ...launchedSessionIds };
      if (activeSessionId) nextLaunchedSessionIds[activeSessionId] = true;
      return {
        sessions,
        activeSessionId,
        closeConfirmations,
        launchedSessionIds: nextLaunchedSessionIds,
        gitNonce,
        sessionTimelines,
        recentSessionIds: state.recentSessionIds.filter((sid) => sid !== id),
      };
    });
  },

  setActive: (id) => {
    if (!get().sessions.some((session) => session.id === id)) return;
    const currentId = get().activeSessionId;
    if (currentId && currentId !== id) {
      if (!requestDirtyDraftAction([currentId], () => get().setActive(id))) return;
    }
    let accepted = false;
    set((state) => {
      if (!state.sessions.some((s) => s.id === id)) return {};
      accepted = true;
      return {
        activeSessionId: id,
        launchedSessionIds: { ...state.launchedSessionIds, [id]: true },
        recentSessionIds: [id, ...state.recentSessionIds.filter((sid) => sid !== id)],
        sessions: state.sessions.map((s) =>
          s.id === id && s.unread ? { ...s, unread: false } : s,
        ),
      };
    });
    if (accepted) ensureSessionVisibleInSplit(id);
  },

  // Cycle to the next/prev session by most-recent-active order (Mod+Tab). "next"
  // walks toward older sessions; "prev" walks back toward the most recent. Falls
  // back to session list order for any sessions never activated this run.
  cycleSession: (direction) => {
    const state = get();
    if (state.sessions.length < 2) return;
    const seen = new Set(state.recentSessionIds);
    const order = [
      ...state.recentSessionIds.filter((id) => state.sessions.some((s) => s.id === id)),
      ...state.sessions.filter((s) => !seen.has(s.id)).map((s) => s.id),
    ];
    if (order.length < 2) return;
    const current = state.activeSessionId ?? order[0];
    const idx = order.indexOf(current);
    const step = direction === "next" ? 1 : -1;
    const nextIdx = (idx + step + order.length) % order.length;
    get().setActive(order[nextIdx]);
  },

  refreshGit: (id) => {
    // Both local and remote sessions refresh via the nonce bump. For remote
    // (SSH) sessions, MainArea's effect routes the nonce change to
    // ssh_git_status over the exec channel instead of the local git2 path.
    scheduleGitRefresh(id, set);
  },

  clearCloseConfirmation: (id) => {
    cancelCloseConfirmationTimer(id);
    set((state) => {
      const { [id]: _removed, ...closeConfirmations } = state.closeConfirmations;
      return { closeConfirmations };
    });
  },

  clearDirCloseConfirmation: (dir) => {
    cancelDirCloseConfirmationTimer(dir);
    set((state) => {
      const { [dir]: _removed, ...dirCloseConfirmations } = state.dirCloseConfirmations;
      return { dirCloseConfirmations };
    });
  },

  recordRecentDir: (dir) =>
    set((state) => ({ recentDirs: pushRecentDir(state.recentDirs, dir) })),

  recordRecentCommand: (command) =>
    set((state) => ({ recentCommands: pushRecentCommand(state.recentCommands, command) })),

  togglePinnedSession: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, pinned: !s.pinned, updatedAt: Date.now() } : s,
      ),
    })),

  appendTimeline: (id, type, detail) => {
    const event = createTimelineEvent(type, detail);
    set((state) => {
      const current = state.sessionTimelines[id] ?? [];
      return {
        sessionTimelines: {
          ...state.sessionTimelines,
          [id]: appendTimelineEvent(current, event),
        },
      };
    });
  },

  handleConnectionEvent: (id, event) => {
    const session = get().sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    const previousPhase = session.connection?.phase;
    const connection = reduceConnectionEvidence(session.connection, event);
    if (connection === session.connection) return;
    if (connection.phase === "ready" && previousPhase !== "ready") {
      get().appendTimeline(id, "connection_ready", connection.transport);
    } else if (connection.phase === "failed") {
      get().appendTimeline(id, "connection_failed", connection.reason);
    } else if (connection.phase === "disconnected") {
      get().appendTimeline(id, "connection_lost", connection.transport);
    }
    get().updateSession(id, { connection });
  },

  setSessionNote: (id, note) => {
    const cleanNote = sanitizeSessionNote(note);
    let saved = false;
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== id || (s.note ?? "") === cleanNote) return s;
        saved = true;
        return { ...s, note: cleanNote || undefined, updatedAt: Date.now() };
      }),
    }));
    if (saved) get().appendTimeline(id, "note_saved");
  },

  closeSessions: (ids, opts) => {
    const uniqueIds = new Set(ids);
    const orderedTargets = get().sessions.filter((s) => uniqueIds.has(s.id));
    if (orderedTargets.length === 0) return true;
    if (!requestDirtyDraftAction(
      orderedTargets.map((session) => session.id),
      () => { get().closeSessions(ids, opts); },
    )) return false;

    const now = Date.now();
    const unconfirmedBusy = orderedTargets.filter((s) =>
      isSessionBusy(s) && now - getNumberRecordValue(get().closeConfirmations, s.id) > CLOSE_CONFIRM_WINDOW_MS,
    );
    if (unconfirmedBusy.length > 0) {
      set((state) => {
        const closeConfirmations = { ...state.closeConfirmations };
        for (const s of unconfirmedBusy) closeConfirmations[s.id] = now;
        return { closeConfirmations };
      });
      for (const s of unconfirmedBusy) {
        scheduleCloseConfirmationExpiry(s.id, get().clearCloseConfirmation);
      }
      const toastSessionId = get().activeSessionId ?? get().sessions[0]?.id;
      if (toastSessionId) {
        useUIStore.getState().addToast({
          sessionId: toastSessionId,
          title: t("destructive.confirm_again.close"),
          subtitle: opts?.toastSubtitle ?? t("session.close.running_hint"),
          variant: "error",
        });
      }
      return false;
    }

    for (const s of [...orderedTargets].reverse()) {
      if (get().sessions.some((current) => current.id === s.id)) {
        get().closeSession(s.id);
      }
    }
    return true;
  },

  closeSessionsInDir: (dir) => {
    const sessionIds = get().sessions.filter((s) => s.dir === dir).map((s) => s.id);
    if (sessionIds.length === 0) return;
    const closed = get().closeSessions(sessionIds, { toastSubtitle: t("session.close.all_running_hint") });
    if (!closed) {
      const lastConfirm = getNumberRecordValue(get().dirCloseConfirmations, dir);
      if (Date.now() - lastConfirm > CLOSE_CONFIRM_WINDOW_MS) {
        set((state) => ({
          dirCloseConfirmations: { ...state.dirCloseConfirmations, [dir]: Date.now() },
        }));
        scheduleDirCloseConfirmationExpiry(dir, get().clearDirCloseConfirmation);
      }
      return;
    }

    get().clearDirCloseConfirmation(dir);
  },

  markRead: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, unread: false } : s,
      ),
    })),

  updateSession: (id, patch) => {
    const previous = get().sessions.find((s) => s.id === id);
    if (patch.changes !== undefined && previous && shouldRecordGitChange(previous.changes?.files, patch.changes?.files)) {
      const fileCount = patch.changes?.files?.length ?? 0;
      get().appendTimeline(id, "git_change", fileCount > 0 ? `${fileCount} files` : "clean");
    }
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
      ),
    }));
    const session = get().sessions.find((s) => s.id === id);
    if (session && !isSessionBusy(session) && getNumberRecordValue(get().closeConfirmations, id) > 0) {
      get().clearCloseConfirmation(id);
    }
  },

  handleAgentDetected: (id, agent, command) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = agentDetectedUpdate(session, agent);
    const agentResume = reconcileAgentResumeIntent(
      session?.agentResume,
      agent,
      buildAgentResumeIntent(session, agent, command),
    );
    const resumeChanged = agentResume !== session?.agentResume;
    if (update || resumeChanged) {
      // The wrapper and native hook can report the same process start through
      // different channels. Updating resume metadata must not manufacture a
      // second lifecycle entry for an already-detected agent.
      if (update) get().appendTimeline(id, "agent_start", AGENT_NAMES[agent] ?? agent);
      get().updateSession(id, {
        ...(update?.patch ?? {}),
        agentResume,
      });
    }
  },

  recordAgentSessionId: (id, agent, agentSessionId) => {
    const trimmed = agentSessionId.trim();
    if (!trimmed) return;
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    const existing = session.agentResume;
    // The real id from the agent's hook is authoritative — it overrides any
    // resumeId previously scraped from the typed command line.
    if (
      existing?.agent === agent &&
      existing.resumeId === trimmed &&
      existing.confidence === "exact"
    ) {
      return;
    }
    get().updateSession(id, {
      agentResume: {
        agent,
        command: resolveAgentResumeSourceCommand(
          agent,
          existing,
          session.lastCommand,
          AGENT_NAMES[agent] ?? agent,
        ),
        cwd: session.dir,
        provenance: session.remote
          ? {
              transport: "ssh",
              host: session.remote.host,
              port: session.remote.port,
              user: session.remote.user,
              ...(session.remote.identityFile?.trim()
                ? { identityFile: session.remote.identityFile.trim() }
                : {}),
            }
          : { transport: "local" },
        resumeId: trimmed,
        lastSeenAt: Date.now(),
        confidence: "exact",
      },
    });
  },

  handleAgentReady: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = isSessionObserved(get().activeSessionId, id);
    const completedTurn = session?.agentActivity === "running"
      || session?.agentActivity === "waiting_confirmation";
    const update = agentReadyUpdate(session, isActive);
    if (!update) return;
    if (completedTurn) {
      get().appendTimeline(id, "agent_stop", session?.agent ? (AGENT_NAMES[session.agent] ?? session.agent) : undefined);
    }
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
    if (!isActive && completedTurn && session?.agent) {
      const fileCount = session.changes?.files?.length ?? 0;
      const name = AGENT_NAMES[session.agent] ?? session.agent;
      useUIStore.getState().addToast({
        sessionId: id,
        title: name,
        subtitle: fileCount > 0 ? t("agent.toast.done_files", { count: fileCount }) : t("agent.toast.done"),
        variant: "success",
        agentCode: session.agent,
      });
    }
  },

  handleAgentWaitingConfirmation: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = isSessionObserved(get().activeSessionId, id);
    const update = agentWaitingConfirmationUpdate(session, isActive);
    if (update) get().updateSession(id, update.patch);
  },

  handleAgentBusy: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = agentBusyUpdate(session);
    if (update) {
      if (session?.agent) get().appendTimeline(id, "agent_start", AGENT_NAMES[session.agent] ?? session.agent);
      get().updateSession(id, update.patch);
    }
  },

  handleAgentExited: (id, exitCode) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = isSessionObserved(get().activeSessionId, id);
    const update = agentExitedUpdate(session, exitCode, isActive);
    if (!update) return;
    get().appendTimeline(id, "agent_stop", session?.agent ? (AGENT_NAMES[session.agent] ?? session.agent) : undefined);
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
    if (!isActive && session?.agent) {
      const fileCount = session.changes?.files?.length ?? 0;
      const name = AGENT_NAMES[session.agent] ?? session.agent;
      useUIStore.getState().addToast({
        sessionId: id,
        title: name,
        subtitle: exitCode === 0
          ? (fileCount > 0 ? t("agent.toast.done_files", { count: fileCount }) : t("agent.toast.done"))
          : t("agent.toast.exited", { code: exitCode }),
        variant: exitCode === 0 ? "success" : "error",
        agentCode: session.agent,
      });
    }
  },

  handleCommandDetected: (id, command) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = commandDetectedUpdate(session, command);
    if (update) {
      get().recordRecentCommand(command);
      get().appendTimeline(id, "command_start", command);
      get().updateSession(id, update.patch);
    }
  },

  handleCommandFinished: (id, exitCode) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = isSessionObserved(get().activeSessionId, id);
    const update = commandFinishedUpdate(session, exitCode, isActive);
    if (!update) return;
    get().appendTimeline(id, "command_end", session?.lastCommand);
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
    if (!isActive && session?.lastCommand) {
      const cmd = session.lastCommand.length > 30
        ? session.lastCommand.slice(0, 30) + "…"
        : session.lastCommand;
      useUIStore.getState().addToast({
        sessionId: id,
        title: cmd,
        subtitle: exitCode === 0 ? t("command.toast.done") : t("command.toast.failed", { code: exitCode }),
        variant: exitCode === 0 ? "success" : "error",
      });
    }
  },

  handleTerminalExited: (id, exitCode) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = terminalExitedUpdate(session, exitCode, isSessionObserved(get().activeSessionId, id));
    if (!update) return;
    const terminalId = session ? previewSourceContext(session).terminalId : undefined;
    get().updateSession(id, {
      ...update.patch,
      ...(terminalId && session?.previewSources
        ? { previewSources: markPreviewSourcesStale(session.previewSources, terminalId) }
        : {}),
    });
    if (update.refreshGit) get().refreshGit(id);
  },

  handleTerminalOutput: (id, output, discoveredAt = Date.now()) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    const detected = detectPreviewSources(output, previewSourceContext(session), discoveredAt);
    if (detected.length === 0) return;
    get().updateSession(id, {
      previewSources: mergePreviewSources(session.previewSources ?? [], detected),
    });
  },

  handleCwdChange: (id, cwd) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = cwdChangedUpdate(session, cwd);
    if (!update) return;
    get().updateSession(id, update.patch);
    // Remote sessions' cwd is a remote path (and the dir label is user@host) —
    // keep it out of the local recent-dirs affordance, matching addSession.
    if (!session?.remote) get().recordRecentDir(cwd);
    if (update.refreshGit) get().refreshGit(id);
  },

  // 用户在【本地】会话里手敲了一条可识别的 ssh 命令 → 给出「改用内置 SSH」建议。
  // 远程会话(已 remote)、已忽略过该 host、或已有相同建议时不打扰。
  suggestSshConnect: (id, target) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session || session.remote) return;
    if (session.dismissedSshHosts?.includes(target.host)) return;
    const cur = session.sshSuggestion;
    if (cur && cur.host === target.host && cur.user === target.user && cur.port === target.port) return;
    get().updateSession(id, { sshSuggestion: target });
  },

  // 用户采纳了建议(点「打开」):只清掉当前建议条,不拉黑 host——
  // 否则用户在 SSH 对话框里取消后,再敲同一命令就再也得不到提示。
  clearSshSuggestion: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session?.sshSuggestion) return;
    get().updateSession(id, { sshSuggestion: null });
  },

  // 用户关闭建议(点「×」):清空当前建议,并把该 host 记入本会话忽略集,避免再次弹出。
  dismissSshSuggestion: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session?.sshSuggestion) return;
    const host = session.sshSuggestion.host;
    const dismissed = session.dismissedSshHosts ?? [];
    get().updateSession(id, {
      sshSuggestion: null,
      dismissedSshHosts: dismissed.includes(host) ? dismissed : [...dismissed, host],
    });
  },

  handleShellTitle: (id, title) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = shellTitleUpdate(session, title);
    if (update) get().updateSession(id, update.patch);
  },

  handleTerminalProgress: (id, progress) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = terminalProgressUpdate(session, progress);
    if (update) get().updateSession(id, update.patch);
  },

  renameSession: (id, name) => {
    const trimmed = name.trim();
    get().updateSession(id, { customTitle: trimmed || undefined });
    set({ renamingSessionId: null });
  },

  startRenaming: (id) => set({ renamingSessionId: id }),
  stopRenaming: () => set({ renamingSessionId: null }),

  reorderInGroup: (dir, fromIndex, toIndex) =>
    set((state) => {
      if (fromIndex === toIndex) return {};
      const group = state.sessions.filter((s) => s.dir === dir);
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= group.length || toIndex >= group.length) return {};
      const movedId = group[fromIndex].id;
      const targetId = group[toIndex].id;
      const sessions = [...state.sessions];
      const globalFrom = sessions.findIndex((s) => s.id === movedId);
      const globalTo = sessions.findIndex((s) => s.id === targetId);
      const [item] = sessions.splice(globalFrom, 1);
      sessions.splice(globalTo, 0, item);
      return { sessions };
    }),

  newTerminal: () => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    get().addSession(createSession(localTerminalCwdFromSession(active), { title: t("session.default_title") }));
  },

  newTerminalInDir: (dir) => {
    get().addSession(createSession(dir, { title: t("session.default_title") }));
  },

  newTerminalWithInput: (input, dir) => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    get().addSession(createSession(dir ?? localTerminalCwdFromSession(active), {
      title: t("session.default_title"),
      pendingInput: input,
      pendingInputSubmit: false,
    }));
  },

  splitWithNewSession: (direction) => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    const splitContext = splitTerminalContextFromSession(active);
    const newSess = createSession(splitContext.dir, {
      title: t("session.default_title"),
      remote: splitContext.remote,
    });
    if (!active) {
      get().addSession(newSess);
      return;
    }
    get().addSession(newSess);
    const ui = useUIStore.getState();
    if (direction === "horizontal") {
      ui.splitHorizontal(active.id, newSess.id);
    } else {
      ui.splitVertical(active.id, newSess.id);
    }
  },

  closeSession: (id) => {
    if (!requestDirtyDraftAction([id], () => get().closeSession(id))) return;
    const session = get().sessions.find((s) => s.id === id);
    if (session && isSessionBusy(session)) {
      const lastConfirm = getNumberRecordValue(get().closeConfirmations, id);
      if (Date.now() - lastConfirm > CLOSE_CONFIRM_WINDOW_MS) {
        set((state) => ({
          closeConfirmations: { ...state.closeConfirmations, [id]: Date.now() },
        }));
        scheduleCloseConfirmationExpiry(id, get().clearCloseConfirmation);
        useUIStore.getState().addToast({
          sessionId: id,
          title: t("destructive.confirm_again.close"),
          subtitle: t("session.close.running_hint"),
          variant: "error",
        });
        return;
      }
    }

    const ui = useUIStore.getState();
    let survivor: string | null = null;
    if (ui.split.mode !== "single") {
      const split = ui.split;
      if (split.paneA === id || split.paneB === id) {
        survivor = split.paneA === id ? split.paneB : split.paneA;
        ui.closeSplit();
      }
    }
    get().removeSession(id);
    if (survivor && get().sessions.some((s) => s.id === survivor)) {
      set({ activeSessionId: survivor });
    }
    if (get().sessions.length === 0) get().addSession(createSession("~", { title: t("session.default_title") }));
  },
}));
