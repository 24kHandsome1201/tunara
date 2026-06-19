// 会话终态持久化（实施文档 §4.2 修 P2-16 / D5）
//
// 用 tauri-plugin-store 存事实字段(runState/completedAt/error/resultSummary/unread)。
// 只持久化已结束的会话——running 的不存（重启后不会错显 running）。
// UI 的 fresh/done 由事实字段派生，不持久化 status。

import { load } from "@tauri-apps/plugin-store";
import type { Session } from "@/ui/types";

const STORE_FILE = "conduit-sessions.json";
const SESSIONS_KEY = "sessions";

type PersistedSession = Pick<
  Session,
  | "id"
  | "kind"
  | "agent"
  | "agentSessionId"
  | "title"
  | "dir"
  | "branch"
  | "prompt"
  | "runState"
  | "startedAt"
  | "completedAt"
  | "unread"
  | "result"
  | "error"
  | "costUsd"
  | "updatedAt"
>;

function toPersistedSession(s: Session): PersistedSession | null {
  // 只持久化已结束的会话
  if (s.runState === "running" || s.runState === "idle") return null;
  return {
    id: s.id,
    kind: s.kind,
    agent: s.agent,
    agentSessionId: s.agentSessionId,
    title: s.title,
    dir: s.dir,
    branch: s.branch,
    prompt: s.prompt,
    runState: s.runState,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    unread: s.unread,
    result: s.result,
    error: s.error,
    costUsd: s.costUsd,
    updatedAt: s.updatedAt,
  };
}

function fromPersistedSession(p: PersistedSession): Session {
  return {
    ...p,
    reply: "",
    blocks: [],
  };
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    const persisted = sessions
      .map(toPersistedSession)
      .filter((s): s is PersistedSession => s !== null);
    await store.set(SESSIONS_KEY, persisted);
    await store.save();
  } catch {
    // store 不可用（非 Tauri 环境 / 权限问题）时静默忽略
  }
}

export async function loadSessions(): Promise<Session[]> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    const persisted = await store.get<PersistedSession[]>(SESSIONS_KEY);
    if (!persisted) return [];
    return persisted.map(fromPersistedSession);
  } catch {
    return [];
  }
}
