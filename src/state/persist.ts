import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
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
type WorkspaceStoreFileState = "missing" | "present";

export type WorkspaceSnapshotLoadResult =
  | { status: "loaded"; snapshot: WorkspaceSnapshotV1 }
  | { status: "empty" }
  | { status: "error"; error: string };

export type WorkspaceSnapshotSaveResult = "saved" | "blocked" | "error";

let workspacePersistenceBlocked = false;

interface PersistedUILayout {
  sidebarVisible: boolean;
  panelVisible: boolean;
}

async function openCheckedStore(file: string): Promise<SessionStore> {
  const fileState = await invoke<WorkspaceStoreFileState>("workspace_store_file_state", { file });
  const store = await load(file, { defaults: {} });
  if (fileState === "present") {
    // Initial load swallows disk/JSON errors inside plugin-store. Reload does
    // not, so an existing corrupt file cannot masquerade as an empty store.
    await store.reload({ ignoreDefaults: true });
  }
  return store;
}

async function loadSessionStore(): Promise<SessionStore> {
  const store = await openCheckedStore(STORE_FILE);
  if ((await store.length()) > 0) return store;

  const legacyStore = await openCheckedStore(LEGACY_STORE_FILE);
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

export async function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): Promise<WorkspaceSnapshotSaveResult> {
  if (workspacePersistenceBlocked) return "blocked";
  try {
    const sanitized = sanitizeSnapshot(snapshot);
    if (!sanitized) return "error";
    const store = await loadSessionStore();
    await store.set(WORKSPACE_SNAPSHOT_KEY, sanitized);
    await store.save();
    return "saved";
  } catch {
    // store unavailable
    return "error";
  }
}

export async function loadWorkspaceSnapshot(): Promise<WorkspaceSnapshotLoadResult> {
  workspacePersistenceBlocked = false;
  try {
    const store = await loadSessionStore();
    const raw = await store.get<unknown>(WORKSPACE_SNAPSHOT_KEY);
    const snapshot = sanitizeSnapshot(raw);
    if (snapshot) return { status: "loaded", snapshot };
    if (raw !== undefined) throw new Error("workspace snapshot is invalid");

    const persisted = await store.get<unknown>(SESSIONS_KEY);
    const activeId = await store.get<unknown>(ACTIVE_KEY);
    const layoutRaw = await store.get<unknown>(UI_LAYOUT_KEY);

    if (persisted !== undefined && !Array.isArray(persisted)) {
      throw new Error("legacy sessions payload is invalid");
    }
    if (Array.isArray(persisted) && !persisted.every(isPersistedSession)) {
      throw new Error("legacy sessions contain invalid entries");
    }
    const sessions = Array.isArray(persisted)
      ? dedupeById(persisted.map(sanitizePersistedSession))
      : [];

    if (sessions.length === 0) return { status: "empty" };

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

    return { status: "loaded", snapshot: migrated };
  } catch (error) {
    workspacePersistenceBlocked = true;
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
