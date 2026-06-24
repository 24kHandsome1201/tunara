import { load } from "@tauri-apps/plugin-store";
import type { Session } from "@/ui/types";
import { sanitizeRecentDirs } from "./recent-dirs";
import { sanitizeRecentCommands } from "./recent-commands";

const STORE_FILE = "tunara-sessions.json";
const LEGACY_STORE_FILE = "conduit-sessions.json";
const SESSIONS_KEY = "sessions";
const ACTIVE_KEY = "activeSessionId";
const UI_LAYOUT_KEY = "uiLayout";
const WORKSPACE_SNAPSHOT_KEY = "workspaceSnapshot";

type SessionStore = Awaited<ReturnType<typeof load>>;

type PersistedSession = Pick<
  Session,
  "id" | "title" | "dir" | "branch" | "updatedAt"
> & { customTitle?: string };

export type PersistedSessionV2 = PersistedSession;

export interface PersistedUILayoutV2 {
  sidebarVisible: boolean;
  panelVisible: boolean;
  collapsedDirs: Record<string, true>;
  split: {
    mode: "single" | "horizontal" | "vertical";
    paneA: string | null;
    paneB: string | null;
    ratio: number;
  };
  inspectorTab: "changes" | "files";
}

export interface PersistedTerminalSnapshot {
  serialized: string;
  viewportY: number;
  baseY: number;
  cols: number;
  rows: number;
  capturedAt: number;
  truncated: boolean;
}

export interface PersistedAgentResumeIntent {
  agent: "CC" | "CX" | "AM" | string;
  command: string;
  cwd: string;
  resumeId?: string;
  lastSeenAt: number;
  confidence: "exact" | "continue" | "unknown";
}

export interface WorkspaceSnapshotV1 {
  version: 1;
  savedAt: number;
  activeSessionId: string | null;
  sessions: PersistedSessionV2[];
  ui: PersistedUILayoutV2;
  terminals: Record<string, PersistedTerminalSnapshot>;
  agentResume: Record<string, PersistedAgentResumeIntent>;
  recentDirs: string[];
  recentCommands: string[];
}

interface PersistedUILayout {
  sidebarVisible: boolean;
  panelVisible: boolean;
}

function toPersistedSession(s: Session): PersistedSession {
  const p: PersistedSession = {
    id: s.id,
    title: s.title,
    dir: s.dir,
    branch: s.branch,
    updatedAt: s.updatedAt,
  };
  if (s.customTitle) p.customTitle = s.customTitle;
  return p;
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
    customTitle: p.customTitle || undefined,
    runState: "idle",
  };
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
    const store = await loadSessionStore();
    const persisted = dedupeById(sessions).map(toPersistedSession);
    await store.set(SESSIONS_KEY, persisted);
    if (activeSessionId !== undefined) {
      await store.set(ACTIVE_KEY, activeSessionId);
    }
    const existing = await store.get<unknown>(WORKSPACE_SNAPSHOT_KEY);
    const snapshot = sanitizeSnapshot(existing);
    const updated: WorkspaceSnapshotV1 = {
      version: 1,
      savedAt: Date.now(),
      activeSessionId: activeSessionId !== undefined ? activeSessionId : (snapshot?.activeSessionId ?? null),
      sessions: persisted,
      ui: snapshot?.ui ?? DEFAULT_UI_LAYOUT_V2,
      terminals: snapshot?.terminals ?? {},
      agentResume: snapshot?.agentResume ?? {},
      recentDirs: snapshot?.recentDirs ?? sanitizeRecentDirs(persisted.map((s) => s.dir)),
      recentCommands: snapshot?.recentCommands ?? [],
    };
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

const DEFAULT_UI_LAYOUT_V2: PersistedUILayoutV2 = {
  sidebarVisible: true,
  panelVisible: true,
  collapsedDirs: {},
  split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
  inspectorTab: "changes",
};

function isValidSplitMode(v: unknown): v is "single" | "horizontal" | "vertical" {
  return v === "single" || v === "horizontal" || v === "vertical";
}

function isValidInspectorTab(v: unknown): v is "changes" | "files" {
  return v === "changes" || v === "files";
}

export function sanitizeSnapshot(raw: unknown): WorkspaceSnapshotV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;

  const sessionsRaw = obj.sessions;
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions = dedupeById(sessionsRaw.filter(isPersistedSession));

  const sessionIds = new Set(sessions.map((s) => s.id));

  let activeSessionId: string | null = typeof obj.activeSessionId === "string" ? obj.activeSessionId : null;
  if (activeSessionId && !sessionIds.has(activeSessionId)) {
    activeSessionId = sessions[0]?.id ?? null;
  }

  let ui: PersistedUILayoutV2;
  const uiRaw = obj.ui as Record<string, unknown> | undefined;
  if (uiRaw && typeof uiRaw === "object") {
    const sidebarVisible = typeof uiRaw.sidebarVisible === "boolean" ? uiRaw.sidebarVisible : true;
    const panelVisible = typeof uiRaw.panelVisible === "boolean" ? uiRaw.panelVisible : true;

    let collapsedDirs: Record<string, true> = {};
    if (uiRaw.collapsedDirs && typeof uiRaw.collapsedDirs === "object") {
      for (const [k, v] of Object.entries(uiRaw.collapsedDirs as Record<string, unknown>)) {
        if (v === true) collapsedDirs[k] = true;
      }
    }

    let split = DEFAULT_UI_LAYOUT_V2.split;
    const splitRaw = uiRaw.split as Record<string, unknown> | undefined;
    if (splitRaw && typeof splitRaw === "object" && isValidSplitMode(splitRaw.mode)) {
      const paneA = typeof splitRaw.paneA === "string" ? splitRaw.paneA : null;
      const paneB = typeof splitRaw.paneB === "string" ? splitRaw.paneB : null;
      const ratio = typeof splitRaw.ratio === "number" && Number.isFinite(splitRaw.ratio)
        ? Math.max(0.2, Math.min(0.8, splitRaw.ratio))
        : 0.5;

      if (splitRaw.mode !== "single" && paneA && paneB && paneA !== paneB && sessionIds.has(paneA) && sessionIds.has(paneB)) {
        split = { mode: splitRaw.mode, paneA, paneB, ratio };
      } else {
        split = { mode: "single", paneA: null, paneB: null, ratio: 0.5 };
      }
    }

    const inspectorTab = isValidInspectorTab(uiRaw.inspectorTab) ? uiRaw.inspectorTab : "changes";

    ui = { sidebarVisible, panelVisible, collapsedDirs, split, inspectorTab };
  } else {
    ui = { ...DEFAULT_UI_LAYOUT_V2 };
  }

  if (ui.split.mode !== "single" && activeSessionId !== ui.split.paneA && activeSessionId !== ui.split.paneB) {
    activeSessionId = ui.split.paneB ?? ui.split.paneA ?? activeSessionId;
  }

  const terminals: Record<string, PersistedTerminalSnapshot> = {};
  if (obj.terminals && typeof obj.terminals === "object") {
    for (const [k, v] of Object.entries(obj.terminals as Record<string, unknown>)) {
      if (!sessionIds.has(k)) continue;
      if (!v || typeof v !== "object") continue;
      const t = v as Record<string, unknown>;
      if (
        typeof t.serialized === "string" &&
        typeof t.viewportY === "number" &&
        typeof t.baseY === "number" &&
        typeof t.cols === "number" &&
        typeof t.rows === "number" &&
        typeof t.capturedAt === "number" &&
        typeof t.truncated === "boolean"
      ) {
        terminals[k] = t as unknown as PersistedTerminalSnapshot;
      }
    }
  }

  const agentResume: Record<string, PersistedAgentResumeIntent> = {};
  if (obj.agentResume && typeof obj.agentResume === "object") {
    for (const [k, v] of Object.entries(obj.agentResume as Record<string, unknown>)) {
      if (!sessionIds.has(k)) continue;
      if (!v || typeof v !== "object") continue;
      const a = v as Record<string, unknown>;
      if (
        typeof a.agent === "string" &&
        typeof a.command === "string" &&
        typeof a.cwd === "string" &&
        typeof a.lastSeenAt === "number" &&
        Number.isFinite(a.lastSeenAt) &&
        (a.confidence === "exact" || a.confidence === "continue" || a.confidence === "unknown")
      ) {
        agentResume[k] = {
          agent: a.agent,
          command: a.command,
          cwd: a.cwd,
          ...(typeof a.resumeId === "string" ? { resumeId: a.resumeId } : {}),
          lastSeenAt: a.lastSeenAt,
          confidence: a.confidence,
        };
      }
    }
  }

  const savedAt = typeof obj.savedAt === "number" && Number.isFinite(obj.savedAt) ? obj.savedAt : 0;
  const recentDirs = sanitizeRecentDirs(
    obj.recentDirs,
  );
  const fallbackRecentDirs = sanitizeRecentDirs(sessions.map((s) => s.dir));
  const recentCommands = sanitizeRecentCommands(obj.recentCommands);

  return {
    version: 1,
    savedAt,
    activeSessionId,
    sessions,
    ui,
    terminals,
    agentResume,
    recentDirs: recentDirs.length ? recentDirs : fallbackRecentDirs,
    recentCommands,
  };
}

export async function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): Promise<void> {
  try {
    const store = await loadSessionStore();
    await store.set(WORKSPACE_SNAPSHOT_KEY, snapshot);
    await store.save();
  } catch {
    // store unavailable
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
      ? dedupeById(persisted.filter(isPersistedSession))
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
      split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
      inspectorTab: "changes",
    };

    const migrated: WorkspaceSnapshotV1 = {
      version: 1,
      savedAt: Date.now(),
      activeSessionId,
      sessions,
      ui,
      terminals: {},
      agentResume: {},
      recentDirs: sanitizeRecentDirs(sessions.map((s) => s.dir)),
      recentCommands: [],
    };

    await store.set(WORKSPACE_SNAPSHOT_KEY, migrated);
    await store.save();

    return migrated;
  } catch {
    return null;
  }
}
