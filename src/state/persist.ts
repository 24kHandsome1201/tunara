import { load } from "@tauri-apps/plugin-store";
import type { Session } from "@/ui/types";

const STORE_FILE = "conduit-sessions.json";
const SESSIONS_KEY = "sessions";
const ACTIVE_KEY = "activeSessionId";
const UI_LAYOUT_KEY = "uiLayout";

type PersistedSession = Pick<
  Session,
  "id" | "title" | "dir" | "branch" | "agent" | "updatedAt"
>;

interface PersistedUILayout {
  sidebarVisible: boolean;
  panelVisible: boolean;
}

function toPersistedSession(s: Session): PersistedSession {
  return {
    id: s.id,
    title: s.title,
    dir: s.dir,
    branch: s.branch,
    agent: s.agent,
    updatedAt: s.updatedAt,
  };
}

function fromPersistedSession(p: PersistedSession): Session {
  return { ...p, runState: "idle" };
}

export async function saveSessions(
  sessions: Session[],
  activeSessionId?: string | null,
): Promise<void> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    const persisted = sessions.map(toPersistedSession);
    await store.set(SESSIONS_KEY, persisted);
    if (activeSessionId !== undefined) {
      await store.set(ACTIVE_KEY, activeSessionId);
    }
    await store.save();
  } catch {
    // store unavailable
  }
}

export async function loadSessions(): Promise<{
  sessions: Session[];
  activeSessionId: string | null;
}> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    const persisted = await store.get<PersistedSession[]>(SESSIONS_KEY);
    const activeId = await store.get<string | null>(ACTIVE_KEY);
    if (!persisted) return { sessions: [], activeSessionId: null };
    return {
      sessions: persisted.map(fromPersistedSession),
      activeSessionId: activeId ?? null,
    };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

export async function saveUILayout(layout: PersistedUILayout): Promise<void> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    await store.set(UI_LAYOUT_KEY, layout);
    await store.save();
  } catch {
    // store unavailable
  }
}

export async function loadUILayout(): Promise<PersistedUILayout | null> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    return (await store.get<PersistedUILayout>(UI_LAYOUT_KEY)) ?? null;
  } catch {
    return null;
  }
}
