// 会话编排 store（实施文档 §4.2 + M3）
//
// Zustand store 持有 Session[]，事件驱动状态机（applyEvent），支持持久化事实字段。
// UI 的 fresh/done 由 deriveStatus 从事实字段派生（修 P2-16）。

import { create } from "zustand";
import type { Session, AgentEvent, SessionKind, AgentCode } from "@/ui/types";

interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  /** 每个会话的 git 刷新信号——bump 后 DiffPanel 重新拉取 status/diff */
  gitNonce: Record<string, number>;

  // ── 动作 ──
  addSession: (s: Session) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  applyEvent: (sessionId: string, ev: AgentEvent) => void;
  appendReplyChunk: (sessionId: string, chunk: string) => void;
  markRead: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  refreshGit: (id: string) => void;
}

let nextId = 1;

export function makeSessionId(): string {
  return `s-${Date.now()}-${nextId++}`;
}

export function createSession(
  kind: SessionKind,
  dir: string,
  opts?: { agent?: AgentCode; title?: string; branch?: string; prompt?: string },
): Session {
  const id = makeSessionId();
  return {
    id,
    kind,
    agent: opts?.agent,
    title: opts?.title ?? (kind === "shell" ? "终端" : "Agent 会话"),
    dir,
    branch: opts?.branch ?? "",
    prompt: opts?.prompt,
    runState: "idle",
    reply: "",
    blocks: [],
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

  applyEvent: (sessionId, ev) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? applyAgentEvent(s, ev) : s,
      ),
    })),

  // chunk buffer + rAF 合并（§4.4）：delta 不逐条进 applyEvent，
  // 攒成 chunk 后一帧只 setState 一次。
  appendReplyChunk: (sessionId, chunk) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, reply: s.reply + chunk, updatedAt: Date.now() }
          : s,
      ),
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
        s.id === id ? { ...s, ...patch } : s,
      ),
    })),
}));

// ── 状态机：agent 事件 → 会话事实字段更新 ──
// 注意：delta 不走这里（走 appendReplyChunk + chunk buffer + rAF），
// 只处理"块级"事件（§4.2 修 P2-14）。
function applyAgentEvent(s: Session, ev: AgentEvent): Session {
  const now = Date.now();
  switch (ev.kind) {
    case "started":
      return {
        ...s,
        runState: "running",
        startedAt: now,
        updatedAt: now,
        agentSessionId: ev.agentSessionId ?? s.agentSessionId,
      };
    case "delta":
      // 如果小量 delta 直接进 applyEvent（非 batch 路径），也处理。
      return { ...s, reply: s.reply + ev.text, updatedAt: now };
    case "toolUse":
      return {
        ...s,
        blocks: [
          ...s.blocks,
          { type: "toolUse", name: ev.name, summary: ev.summary },
        ],
        updatedAt: now,
      };
    case "fileChange":
      return {
        ...s,
        blocks: [...s.blocks, { type: "fileChange", path: ev.path }],
        updatedAt: now,
      };
    case "done":
      return {
        ...s,
        runState: ev.ok ? "completed" : "failed",
        result: ev.result,
        costUsd: ev.costUsd ?? s.costUsd,
        completedAt: now,
        unread: true,
        updatedAt: now,
      };
    case "failed":
      return {
        ...s,
        runState: "failed",
        error: ev.message,
        completedAt: now,
        unread: true,
        updatedAt: now,
      };
  }
}
