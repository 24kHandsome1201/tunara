import { load } from "@tauri-apps/plugin-store";
import { sanitizeRecentDirs } from "./recent-dirs";
import {
  dedupeById,
  isPersistedSession,
  localSessionDirs,
  sanitizePersistedSession,
  sanitizeSnapshot,
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
// Pre-snapshot store keys. Read-only since the WorkspaceSnapshotV1 migration:
// loadWorkspaceSnapshot still consumes them to migrate an old store, but
// nothing writes them anymore (the per-key save/load helpers that did were
// dead code and have been removed — everything persists through the snapshot).
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
