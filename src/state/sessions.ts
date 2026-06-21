import { create } from "zustand";
import type { Session, AgentCode } from "@/ui/types";
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

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  launchedSessionIds: Record<string, true>;
  gitNonce: Record<string, number>;
  closeConfirmations: Record<string, number>;

  addSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  markRead: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  refreshGit: (id: string) => void;
  clearCloseConfirmation: (id: string) => void;

  handleAgentDetected: (id: string, agent: AgentCode) => void;
  handleAgentReady: (id: string) => void;
  handleAgentBusy: (id: string) => void;
  handleAgentExited: (id: string, exitCode: number) => void;
  handleCommandDetected: (id: string, command: string) => void;
  handleCommandFinished: (id: string, exitCode: number) => void;
  handleCwdChange: (id: string, cwd: string) => void;
  handleShellTitle: (id: string, title: string) => void;

  reorderInGroup: (dir: string, fromIndex: number, toIndex: number) => void;
  newTerminal: () => void;
  newTerminalInDir: (dir: string) => void;
  splitWithNewSession: (direction: "horizontal" | "vertical") => void;
  closeSession: (id: string) => void;
}

let nextId = 1;

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
    runState: "idle" as const,
    pendingInput: opts?.pendingInput,
    updatedAt: Date.now(),
  };
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  launchedSessionIds: {},
  gitNonce: {},
  closeConfirmations: {},

  addSession: (s) =>
    set((state) => ({
      sessions: [...state.sessions, s],
      activeSessionId: s.id,
      launchedSessionIds: { ...state.launchedSessionIds, [s.id]: true },
    })),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      const { [id]: _removed, ...closeConfirmations } = state.closeConfirmations;
      const { [id]: _launched, ...launchedSessionIds } = state.launchedSessionIds;
      const nextLaunchedSessionIds = { ...launchedSessionIds };
      if (activeSessionId) nextLaunchedSessionIds[activeSessionId] = true;
      return {
        sessions,
        activeSessionId,
        closeConfirmations,
        launchedSessionIds: nextLaunchedSessionIds,
      };
    }),

  setActive: (id) =>
    set((state) => {
      if (!state.sessions.some((s) => s.id === id)) return {};
      return {
        activeSessionId: id,
        launchedSessionIds: { ...state.launchedSessionIds, [id]: true },
        sessions: state.sessions.map((s) =>
          s.id === id && s.unread ? { ...s, unread: false } : s,
        ),
      };
    }),

  refreshGit: (id) =>
    set((state) => ({
      gitNonce: { ...state.gitNonce, [id]: (state.gitNonce[id] ?? 0) + 1 },
    })),

  clearCloseConfirmation: (id) =>
    set((state) => {
      const { [id]: _removed, ...closeConfirmations } = state.closeConfirmations;
      return { closeConfirmations };
    }),

  markRead: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, unread: false } : s,
      ),
    })),

  updateSession: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
      ),
    })),

  handleAgentDetected: (id, agent) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = agentDetectedUpdate(session, agent);
    if (update) get().updateSession(id, update.patch);
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
  },

  handleCwdChange: (id, cwd) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = cwdChangedUpdate(session, cwd);
    if (!update) return;
    get().updateSession(id, update.patch);
    if (update.refreshGit) get().refreshGit(id);
  },

  handleShellTitle: (id, title) => {
    const session = get().sessions.find((s) => s.id === id);
    const update = shellTitleUpdate(session, title);
    if (update) get().updateSession(id, update.patch);
  },

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
      if (Date.now() - lastConfirm > 3_000) {
        set((state) => ({
          closeConfirmations: { ...state.closeConfirmations, [id]: Date.now() },
        }));
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
