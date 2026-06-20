import { create } from "zustand";
import type { Session, AgentCode } from "@/ui/types";

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
}

let nextId = 1;

export function makeSessionId(): string {
  return `s-${Date.now()}-${nextId++}`;
}

export function createSession(
  dir: string,
  opts?: { agent?: AgentCode; title?: string; branch?: string },
): Session {
  const id = makeSessionId();
  return {
    id,
    agent: opts?.agent,
    title: opts?.title ?? "终端",
    dir,
    branch: opts?.branch ?? "",
    runState: "idle" as const,
    updatedAt: Date.now(),
  };
}

export const useSessionsStore = create<SessionsState>()((set) => ({
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
}));
