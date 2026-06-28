import { load } from "@tauri-apps/plugin-store";
import type { Session } from "@/ui/types";
import { sanitizeRecentDirs } from "./recent-dirs";
import {
  DEFAULT_UI_LAYOUT_V2,
  dedupeById,
  fromPersistedSession,
  isPersistedSession,
  localSessionDirs,
  sanitizePersistedSession,
  sanitizeSnapshot,
  toPersistedSession,
  type PersistedUILayoutV2,
  type WorkspaceSnapshotV1,
} from "./persist-snapshot.ts";

export { sanitizeSnapshot } from "./persist-snapshot.ts";
export type {
  PersistedAgentResumeIntent,
  PersistedSessionV2,
  PersistedTerminalSnapshot,
  PersistedUILayoutV2,
  WorkspaceSnapshotV1,
} from "./persist-snapshot.ts";

const STORE_FILE = "tunara-sessions.json";
const LEGACY_STORE_FILE = "conduit-sessions.json";
const SESSIONS_KEY = "sessions";
const ACTIVE_KEY = "activeSessionId";
const UI_LAYOUT_KEY = "uiLayout";
const WORKSPACE_SNAPSHOT_KEY = "workspaceSnapshot";

type SessionStore = Awaited<ReturnType<typeof load>>;

interface PersistedUILayout {
  sidebarVisible: boolean;
  panelVisible: boolean;
}

async function loadSessionStore(): Promise<SessionStore> {
  const store = await load(STORE_FILE, { defaults: {} });
  if ((await store.length()) > 0) return store;

  const legacyStore = await load(LEGACY_STORE_FILE, { defaults: {} });
  const legacyEntries = await legacyStore.entries<unknown>();
  if (legacyEntries.length === 0) return store;

  for (const [key, value] of legacyEntries) {
    await store.set(key, value);
  }
  await store.save();
  return store;
}

function isPersistedUILayout(value: unknown): value is PersistedUILayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Partial<PersistedUILayout>;
  return typeof layout.sidebarVisible === "boolean" && typeof layout.panelVisible === "boolean";
}

export async function saveSessions(
  sessions: Session[],
  activeSessionId?: string | null,
): Promise<void> {
  try {
    const store = await loadSessionStore();
    const persisted = dedupeById(sessions).map(toPersistedSession);
    const existing = await store.get<unknown>(WORKSPACE_SNAPSHOT_KEY);
    const snapshot = sanitizeSnapshot(existing);
    const rawSnapshot: WorkspaceSnapshotV1 = {
      version: 1,
      savedAt: Date.now(),
      activeSessionId: activeSessionId !== undefined ? activeSessionId : (snapshot?.activeSessionId ?? null),
      sessions: persisted,
      ui: snapshot?.ui ?? DEFAULT_UI_LAYOUT_V2,
      terminals: snapshot?.terminals ?? {},
      agentResume: snapshot?.agentResume ?? {},
      recentDirs: snapshot?.recentDirs ?? sanitizeRecentDirs(localSessionDirs(persisted)),
      recentCommands: snapshot?.recentCommands ?? [],
      commandUsage: snapshot?.commandUsage ?? {},
      workflows: snapshot?.workflows ?? [],
    };
    const updated = sanitizeSnapshot(rawSnapshot);
    if (!updated) return;
    await store.set(SESSIONS_KEY, updated.sessions);
    if (activeSessionId !== undefined) {
      await store.set(ACTIVE_KEY, updated.activeSessionId);
    }
    await store.set(WORKSPACE_SNAPSHOT_KEY, updated);
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
    const store = await loadSessionStore();
    const persisted = await store.get<unknown>(SESSIONS_KEY);
    const activeId = await store.get<unknown>(ACTIVE_KEY);
    if (!Array.isArray(persisted)) return { sessions: [], activeSessionId: null };
    const sessions = dedupeById(persisted.filter(isPersistedSession).map(sanitizePersistedSession)).map(fromPersistedSession);
    const activeSessionId = typeof activeId === "string" && sessions.some((s) => s.id === activeId)
      ? activeId
      : sessions[0]?.id ?? null;
    return {
      sessions,
      activeSessionId,
    };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

export async function saveUILayout(layout: PersistedUILayout): Promise<void> {
  try {
    const store = await loadSessionStore();
    await store.set(UI_LAYOUT_KEY, layout);
    const existing = await store.get<unknown>(WORKSPACE_SNAPSHOT_KEY);
    const snapshot = sanitizeSnapshot(existing);
    if (snapshot) {
      snapshot.ui.sidebarVisible = layout.sidebarVisible;
      snapshot.ui.panelVisible = layout.panelVisible;
      snapshot.savedAt = Date.now();
      await store.set(WORKSPACE_SNAPSHOT_KEY, snapshot);
    }
    await store.save();
  } catch {
    // store unavailable
  }
}

export async function loadUILayout(): Promise<PersistedUILayout | null> {
  try {
    const store = await loadSessionStore();
    const layout = await store.get<unknown>(UI_LAYOUT_KEY);
    return isPersistedUILayout(layout) ? layout : null;
  } catch {
    return null;
  }
}

export async function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): Promise<boolean> {
  try {
    const sanitized = sanitizeSnapshot(snapshot);
    if (!sanitized) return false;
    const store = await loadSessionStore();
    await store.set(WORKSPACE_SNAPSHOT_KEY, sanitized);
    await store.save();
    return true;
  } catch {
    // store unavailable
    return false;
  }
}

export async function loadWorkspaceSnapshot(): Promise<WorkspaceSnapshotV1 | null> {
  try {
    const store = await loadSessionStore();
    const raw = await store.get<unknown>(WORKSPACE_SNAPSHOT_KEY);
    const snapshot = sanitizeSnapshot(raw);
    if (snapshot) return snapshot;

    const persisted = await store.get<unknown>(SESSIONS_KEY);
    const activeId = await store.get<unknown>(ACTIVE_KEY);
    const layoutRaw = await store.get<unknown>(UI_LAYOUT_KEY);

    const sessions = Array.isArray(persisted)
      ? dedupeById(persisted.filter(isPersistedSession).map(sanitizePersistedSession))
      : [];

    if (sessions.length === 0) return null;

    const activeSessionId = typeof activeId === "string" && sessions.some((s) => s.id === activeId)
      ? activeId
      : sessions[0]?.id ?? null;

    const layout = isPersistedUILayout(layoutRaw) ? layoutRaw : null;
    const ui: PersistedUILayoutV2 = {
      sidebarVisible: layout?.sidebarVisible ?? true,
      panelVisible: layout?.panelVisible ?? true,
      collapsedDirs: {},
      collapsedDiffSections: {},
      split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
      inspectorTab: "overview",
    };

    const migrated: WorkspaceSnapshotV1 = {
      version: 1,
      savedAt: Date.now(),
      activeSessionId,
      sessions,
      ui,
      terminals: {},
      agentResume: {},
      recentDirs: sanitizeRecentDirs(localSessionDirs(sessions)),
      recentCommands: [],
      commandUsage: {},
      workflows: [],
    };

    await store.set(WORKSPACE_SNAPSHOT_KEY, migrated);
    await store.save();

    return migrated;
  } catch {
    return null;
  }
}
