import { create } from "zustand";
import type { Session, AgentCode } from "@/ui/types";
import { AGENT_NAMES } from "@/ui/types";
import { useUIStore } from "./ui";

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  gitNonce: Record<string, number>;

  addSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  markRead: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  refreshGit: (id: string) => void;

  handleAgentDetected: (id: string, agent: AgentCode) => void;
  handleAgentExited: (id: string, exitCode: number) => void;
  handleCommandDetected: (id: string, command: string) => void;
  handleCommandFinished: (id: string, exitCode: number) => void;
  handleCwdChange: (id: string, cwd: string) => void;
  handleShellTitle: (id: string, title: string) => void;

  newTerminal: () => void;
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
  gitNonce: {},

  addSession: (s) =>
    set((state) => ({
      sessions: [...state.sessions, s],
      activeSessionId: s.id,
    })),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    }),

  setActive: (id) => set({ activeSessionId: id }),

  refreshGit: (id) =>
    set((state) => ({
      gitNonce: { ...state.gitNonce, [id]: (state.gitNonce[id] ?? 0) + 1 },
    })),

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
    get().updateSession(id, {
      agent,
      title: AGENT_NAMES[agent] ?? agent,
      runState: "running",
      startedAt: Date.now(),
      completedAt: undefined,
    });
  },

  handleAgentExited: (id, exitCode) => {
    get().updateSession(id, {
      agent: undefined,
      title: "终端",
      lastCommand: undefined,
      runState: exitCode === 0 ? "done" : "failed",
      completedAt: Date.now(),
    });
    get().refreshGit(id);
  },

  handleCommandDetected: (id, command) => {
    get().updateSession(id, {
      lastCommand: command,
      runState: "running",
      startedAt: Date.now(),
    });
  },

  handleCommandFinished: (id, exitCode) => {
    get().updateSession(id, {
      lastExitCode: exitCode,
      runState: exitCode === 0 ? "done" : "failed",
      completedAt: Date.now(),
    });
    get().refreshGit(id);
  },

  handleCwdChange: (id, cwd) => {
    const session = get().sessions.find((s) => s.id === id);
    const cwdChanged = session?.dir !== cwd;
    const lastCommand = session?.lastCommand?.trim() ?? "";
    get().updateSession(id, {
      dir: cwd,
      ...(cwdChanged && /^(?:cd|pushd|popd)(?:\s|$)/.test(lastCommand)
        ? { lastCommand: undefined }
        : {}),
    });
  },

  handleShellTitle: (id, title) => {
    get().updateSession(id, { shellTitle: title });
  },

  newTerminal: () => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    get().addSession(createSession(active?.dir ?? "~", { title: "终端" }));
  },

  splitWithNewSession: (direction) => {
    const active = get().sessions.find((s) => s.id === get().activeSessionId);
    const newSess = createSession(active?.dir ?? "~", { title: "终端" });
    get().addSession(newSess);
    const ui = useUIStore.getState();
    if (direction === "horizontal") {
      ui.splitHorizontal(newSess.id);
    } else {
      ui.splitVertical(newSess.id);
    }
  },

  closeSession: (id) => {
    const ui = useUIStore.getState();
    if (ui.split.mode !== "single" && ui.split.paneB) {
      if (ui.split.paneB === id) {
        ui.closeSplit();
      } else if (get().activeSessionId === id) {
        set({ activeSessionId: ui.split.paneB });
        ui.closeSplit();
      }
    }
    get().removeSession(id);
    if (get().sessions.length === 0) {
      get().addSession(createSession("~", { title: "终端" }));
    }
  },
}));
