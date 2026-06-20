import { load } from "@tauri-apps/plugin-store";
import type { Session } from "@/ui/types";

const STORE_FILE = "conduit-sessions.json";
const SESSIONS_KEY = "sessions";
const ACTIVE_KEY = "activeSessionId";
const UI_LAYOUT_KEY = "uiLayout";

type PersistedSession = Pick<
  Session,
  "id" | "title" | "dir" | "branch" | "updatedAt"
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
    updatedAt: s.updatedAt,
  };
}

function fromPersistedSession(p: PersistedSession): Session {
  return { ...p, title: "终端", runState: "idle" };
}

function dedupeById<T extends { id: string; updatedAt: number }>(items: T[]): T[] {
  const order: string[] = [];
  const byId = new Map<string, T>();

  for (const item of items) {
    const existing = byId.get(item.id);
    if (!existing) order.push(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) {
      byId.set(item.id, item);
    }
  }

  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

export async function saveSessions(
  sessions: Session[],
  activeSessionId?: string | null,
): Promise<void> {
  try {
    const store = await load(STORE_FILE, { defaults: {} });
    const persisted = dedupeById(sessions).map(toPersistedSession);
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
    const sessions = dedupeById(persisted).map(fromPersistedSession);
    return {
      sessions,
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
