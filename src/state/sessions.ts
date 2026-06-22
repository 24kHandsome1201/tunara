import { create } from "zustand";
import type { Session, AgentCode, AgentResumeIntent } from "@/ui/types";
import { AGENT_NAMES } from "@/ui/types";
import { initialAgentActivity, isSessionBusy } from "@/modules/terminal/lib/agent-lifecycle";
import {
  agentBusyUpdate,
  agentDetectedUpdate,
  agentExitedUpdate,
  agentReadyUpdate,
  commandDetectedUpdate,
  commandFinishedUpdate,
  cwdChangedUpdate,
  shellTitleUpdate,
} from "@/modules/terminal/lib/session-lifecycle";
import { useUIStore } from "./ui";
import { pushRecentDir } from "./recent-dirs";

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  renamingSessionId: string | null;
  launchedSessionIds: Record<string, true>;
  gitNonce: Record<string, number>;
  closeConfirmations: Record<string, number>;
  dirCloseConfirmations: Record<string, number>;
  recentDirs: string[];

  addSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  markRead: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  refreshGit: (id: string) => void;
  clearCloseConfirmation: (id: string) => void;
  closeSessions: (ids: string[]) => boolean;
  closeSessionsInDir: (dir: string) => void;
  clearDirCloseConfirmation: (dir: string) => void;
  recordRecentDir: (dir: string) => void;

  handleAgentDetected: (id: string, agent: AgentCode, command?: string) => void;
  handleAgentReady: (id: string) => void;
  handleAgentBusy: (id: string) => void;
  handleAgentExited: (id: string, exitCode: number) => void;
  handleCommandDetected: (id: string, command: string) => void;
  handleCommandFinished: (id: string, exitCode: number) => void;
  handleCwdChange: (id: string, cwd: string) => void;
  handleShellTitle: (id: string, title: string) => void;

  renameSession: (id: string, name: string) => void;
  startRenaming: (id: string) => void;
  stopRenaming: () => void;
  reorderInGroup: (dir: string, fromIndex: number, toIndex: number) => void;
  newTerminal: () => void;
  newTerminalInDir: (dir: string) => void;
  splitWithNewSession: (direction: "horizontal" | "vertical") => void;
  closeSession: (id: string) => void;
}

let nextId = 1;
const CLOSE_CONFIRM_WINDOW_MS = 3_000;
const closeConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirCloseConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function makeSessionId(): string {
  return `s-${Date.now()}-${nextId++}`;
}

export function createSession(
  dir: string,
  opts?: { agent?: AgentCode; title?: string; branch?: string; pendingInput?: string },
): Session {
  const id = makeSessionId();
  return {
    id,
    agent: opts?.agent,
    agentActivity: opts?.agent ? initialAgentActivity(opts.agent) : undefined,
    title: opts?.title ?? "终端",
    dir,
    branch: opts?.branch ?? "",
    gitState: "unknown",
    runState: "idle" as const,
    pendingInput: opts?.pendingInput,
    pendingInputSubmit: undefined,
    updatedAt: Date.now(),
  };
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

function buildAgentResumeIntent(
  session: Session | undefined,
  agent: AgentCode,
  command?: string,
): AgentResumeIntent | undefined {
  if (!session) return undefined;
  const normalized = command?.trim() || session.agentResume?.command || session.lastCommand?.trim() || "";
  if (!normalized) return undefined;

  const resumeMatch = normalized.match(/(?:^|\s)(?:--resume|resume)\s+([^\s]+)/);
  const continueMatch = /(?:^|\s)(?:--continue|continue)(?:\s|$)/.test(normalized);
  return {
    agent,
    command: normalized,
    cwd: session.dir,
    ...(resumeMatch ? { resumeId: resumeMatch[1] } : {}),
    lastSeenAt: Date.now(),
    confidence: resumeMatch ? "exact" : continueMatch ? "continue" : "unknown",
  };
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

  addSession: (s) => {
    set((state) => ({
      sessions: [...state.sessions, s],
      activeSessionId: s.id,
      launchedSessionIds: { ...state.launchedSessionIds, [s.id]: true },
      recentDirs: pushRecentDir(state.recentDirs, s.dir),
    }));
    ensureSessionVisibleInSplit(s.id);
  },

  removeSession: (id) => {
    cancelCloseConfirmationTimer(id);
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
      const nextLaunchedSessionIds = { ...launchedSessionIds };
      if (activeSessionId) nextLaunchedSessionIds[activeSessionId] = true;
      return {
        sessions,
        activeSessionId,
        closeConfirmations,
        launchedSessionIds: nextLaunchedSessionIds,
        gitNonce,
      };
    });
  },

  setActive: (id) => {
    let accepted = false;
    set((state) => {
      if (!state.sessions.some((s) => s.id === id)) return {};
      accepted = true;
      return {
        activeSessionId: id,
        launchedSessionIds: { ...state.launchedSessionIds, [id]: true },
        sessions: state.sessions.map((s) =>
          s.id === id && s.unread ? { ...s, unread: false } : s,
        ),
      };
    });
    if (accepted) ensureSessionVisibleInSplit(id);
  },

  refreshGit: (id) =>
    set((state) => ({
      gitNonce: { ...state.gitNonce, [id]: (state.gitNonce[id] ?? 0) + 1 },
    })),

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

  closeSessions: (ids) => {
    const uniqueIds = new Set(ids);
    const orderedTargets = get().sessions.filter((s) => uniqueIds.has(s.id));
    if (orderedTargets.length === 0) return true;

    const now = Date.now();
    const unconfirmedBusy = orderedTargets.filter((s) =>
      isSessionBusy(s) && now - (get().closeConfirmations[s.id] ?? 0) > CLOSE_CONFIRM_WINDOW_MS,
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
    const closed = get().closeSessions(sessionIds);
    if (!closed) {
      const lastConfirm = get().dirCloseConfirmations[dir] ?? 0;
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
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
      ),
    }));
    const session = get().sessions.find((s) => s.id === id);
    if (session && !isSessionBusy(session) && get().closeConfirmations[id]) {
      get().clearCloseConfirmation(id);
    }
  },

  handleAgentDetected: (id, agent, command) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = agentDetectedUpdate(session, agent);
    const agentResume = buildAgentResumeIntent(session, agent, command);
    if (update || agentResume) {
      get().updateSession(id, {
        ...(update?.patch ?? {}),
        ...(agentResume ? { agentResume } : {}),
      });
    }
  },

  handleAgentReady: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = get().activeSessionId === id;
    const update = agentReadyUpdate(session, isActive);
    if (!update) return;
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
  },

  handleAgentBusy: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = agentBusyUpdate(session);
    if (update) get().updateSession(id, update.patch);
  },

  handleAgentExited: (id, exitCode) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = get().activeSessionId === id;
    const update = agentExitedUpdate(session, exitCode, isActive);
    if (!update) return;
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
    if (!isActive && session?.agent) {
      const fileCount = session.changes?.files.length ?? 0;
      const name = AGENT_NAMES[session.agent] ?? session.agent;
      useUIStore.getState().addToast({
        sessionId: id,
        title: name,
        subtitle: exitCode === 0
          ? (fileCount > 0 ? `已完成 · 编辑 ${fileCount} 文件` : "已完成")
          : `已退出 (exit ${exitCode})`,
        variant: exitCode === 0 ? "success" : "error",
        agentCode: session.agent,
      });
    }
  },

  handleCommandDetected: (id, command) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = commandDetectedUpdate(session, command);
    if (update) get().updateSession(id, update.patch);
  },

  handleCommandFinished: (id, exitCode) => {
    const session = get().sessions.find((s) => s.id === id);
    const isActive = get().activeSessionId === id;
    const update = commandFinishedUpdate(session, exitCode, isActive);
    if (!update) return;
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
    if (!isActive && session?.lastCommand) {
      const cmd = session.lastCommand.length > 30
        ? session.lastCommand.slice(0, 30) + "…"
        : session.lastCommand;
      useUIStore.getState().addToast({
        sessionId: id,
        title: cmd,
        subtitle: exitCode === 0 ? "完成" : `失败 (exit ${exitCode})`,
        variant: exitCode === 0 ? "success" : "error",
      });
    }
  },

  handleCwdChange: (id, cwd) => {
    const session = get().sessions.find((s) => s.id === id);
    const agentResume = session?.agentResume;
    const update = cwdChangedUpdate(session, cwd);
    if (!update) return;
    get().updateSession(id, {
      ...update.patch,
      ...(agentResume
        ? { agentResume: { ...agentResume, cwd, lastSeenAt: Date.now() } }
        : {}),
    });
    get().recordRecentDir(cwd);
    if (update.refreshGit) get().refreshGit(id);
  },

  handleShellTitle: (id, title) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = shellTitleUpdate(session, title);
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
    get().addSession(createSession(active?.dir ?? "~", { title: "终端" }));
  },

  newTerminalInDir: (dir) => {
    get().addSession(createSession(dir, { title: "终端" }));
  },

  splitWithNewSession: (direction) => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    const newSess = createSession(active?.dir ?? "~", { title: "终端" });
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
    const session = get().sessions.find((s) => s.id === id);
    if (session && isSessionBusy(session)) {
      const lastConfirm = get().closeConfirmations[id] ?? 0;
      if (Date.now() - lastConfirm > CLOSE_CONFIRM_WINDOW_MS) {
        set((state) => ({
          closeConfirmations: { ...state.closeConfirmations, [id]: Date.now() },
        }));
        scheduleCloseConfirmationExpiry(id, get().clearCloseConfirmation);
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
    if (get().sessions.length === 0) {
      get().addSession(createSession("~", { title: "终端" }));
    }
  },
}));
