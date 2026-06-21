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

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PersistedSession>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.dir === "string" &&
    typeof s.branch === "string" &&
    typeof s.updatedAt === "number" &&
    Number.isFinite(s.updatedAt)
  );
}

function fromPersistedSession(p: PersistedSession): Session {
  return {
    ...p,
    title: p.title.trim() || "终端",
    runState: "idle",
  };
}

function isPersistedUILayout(value: unknown): value is PersistedUILayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Partial<PersistedUILayout>;
  return typeof layout.sidebarVisible === "boolean" && typeof layout.panelVisible === "boolean";
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
    const persisted = await store.get<unknown>(SESSIONS_KEY);
    const activeId = await store.get<unknown>(ACTIVE_KEY);
    if (!Array.isArray(persisted)) return { sessions: [], activeSessionId: null };
    const sessions = dedupeById(persisted.filter(isPersistedSession)).map(fromPersistedSession);
    return {
      sessions,
      activeSessionId: typeof activeId === "string" ? activeId : null,
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
    const layout = await store.get<unknown>(UI_LAYOUT_KEY);
    return isPersistedUILayout(layout) ? layout : null;
  } catch {
    return null;
  }
}
