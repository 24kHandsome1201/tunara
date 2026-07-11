import type { Session } from "../ui/types.ts";
import type { Workflow } from "../modules/workflows/template.ts";
import { sanitizeWorkflow } from "../modules/workflows/template.ts";
import { sanitizeSessionNote } from "../modules/session/session-notes.ts";
import {
  MAX_TERMINAL_SNAPSHOTS,
  MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE,
} from "../modules/terminal/lib/terminal-snapshot-limits.ts";
import { trimTerminalSnapshotSerialized } from "../modules/terminal/lib/terminal-snapshot-trim.ts";
import { initialConnectionEvidence } from "../modules/terminal/lib/connection-state.ts";
import { parseSshPort } from "../modules/ssh/hosts-model.ts";
import { sanitizeRecentDirs } from "./recent-dirs.ts";
import { t } from "../modules/i18n/core.ts";
import { sanitizeRecentCommands } from "./recent-commands.ts";
import { isSessionMascotId } from "../modules/session/session-mascot.ts";

export type PersistedSession = Pick<
  Session,
  "id" | "title" | "dir" | "branch" | "updatedAt"
> & { customTitle?: string; remote?: Session["remote"]; mascot?: Session["mascot"]; pinned?: boolean; note?: string };

export type PersistedSessionV2 = PersistedSession;

function sanitizeRemoteInfo(remote: unknown): Session["remote"] | undefined {
  if (!remote || typeof remote !== "object") return undefined;
  const r = remote as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host.trim() : "";
  const user = typeof r.user === "string" ? r.user.trim() : "";
  const port = parseSshPort(r.port);
  if (!host || !user || port === null) return undefined;

  const identityFile = typeof r.identityFile === "string" ? r.identityFile.trim() : "";
  return {
    host,
    port,
    user,
    ...(identityFile ? { identityFile } : {}),
    // Persist the explicit boolean both ways: the backend now defaults a
    // missing value to `true`, so an opt-OUT (`false`) must survive a reopen —
    // dropping it would silently re-enable injection. Only an undefined value
    // (legacy snapshot) is omitted and falls through to the default.
    ...(typeof r.injectShellIntegration === "boolean"
      ? { injectShellIntegration: r.injectShellIntegration }
      : {}),
  };
}

function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}

export interface PersistedUILayoutV2 {
  sidebarVisible: boolean;
  panelVisible: boolean;
  collapsedDirs: Record<string, true>;
  collapsedDiffSections: Record<string, true>;
  split: {
    mode: "single" | "horizontal" | "vertical";
    paneA: string | null;
    paneB: string | null;
    ratio: number;
  };
  inspectorTab: "overview" | "changes" | "files" | "notes";
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
  provenance:
    | { transport: "local" }
    | { transport: "ssh"; host: string; port: number; user: string; identityFile?: string };
  resumeId?: string;
  lastSeenAt: number;
  confidence: "exact" | "continue" | "unknown";
}

function sanitizeResumeProvenance(raw: unknown): PersistedAgentResumeIntent["provenance"] | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.transport === "local") return { transport: "local" };
  if (value.transport !== "ssh") return null;
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const user = typeof value.user === "string" ? value.user.trim() : "";
  const port = parseSshPort(value.port);
  if (!host || host.length > 255 || !user || user.length > 255 || port === null) return null;
  if (/[\0\r\n]/.test(host) || /[\0\r\n]/.test(user)) return null;
  const identityFile = typeof value.identityFile === "string" ? value.identityFile.trim() : "";
  if (identityFile.length > 1024 || /[\0\r\n]/.test(identityFile)) return null;
  return { transport: "ssh", host, port, user, ...(identityFile ? { identityFile } : {}) };
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
  /** Command-palette usage timestamps, keyed by command id, for recency ranking. */
  commandUsage: Record<string, number>;
  /** User-defined command-template workflows. */
  workflows: Workflow[];
}

export const DEFAULT_UI_LAYOUT_V2: PersistedUILayoutV2 = {
  sidebarVisible: true,
  panelVisible: true,
  collapsedDirs: {},
  collapsedDiffSections: {},
  split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
  inspectorTab: "overview",
};

export function toPersistedSession(s: Session): PersistedSession {
  const customTitle = typeof s.customTitle === "string" ? s.customTitle.trim() : "";
  const note = sanitizeSessionNote(s.note);
  const p: PersistedSession = {
    id: s.id,
    title: s.title.trim() || t("session.default_title"),
    dir: s.dir,
    branch: s.branch,
    updatedAt: s.updatedAt,
  };
  if (customTitle) p.customTitle = customTitle;
  if (isSessionMascotId(s.mascot)) p.mascot = s.mascot;
  if (s.pinned === true) p.pinned = true;
  if (note) p.note = note;
  // Persist remote connection info (no secrets) so an SSH session can be
  // re-established after restart. The connection itself is re-opened lazily
  // when the terminal mounts.
  const remote = sanitizeRemoteInfo(s.remote);
  if (remote) p.remote = remote;
  return p;
}

export function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PersistedSession>;
  const remote = (s as Record<string, unknown>).remote;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.dir === "string" &&
    typeof s.branch === "string" &&
    typeof s.updatedAt === "number" &&
    Number.isFinite(s.updatedAt) &&
    isSafeRecordKey(s.id) &&
    (remote === undefined || Boolean(sanitizeRemoteInfo(remote)))
  );
}

export function sanitizePersistedSession(p: PersistedSession): PersistedSession {
  const customTitle = typeof p.customTitle === "string" ? p.customTitle.trim() : "";
  const note = sanitizeSessionNote(p.note);
  const remote = sanitizeRemoteInfo(p.remote);
  const mascot = isSessionMascotId(p.mascot) ? p.mascot : undefined;
  return {
    id: p.id,
    title: p.title.trim() || t("session.default_title"),
    dir: p.dir,
    branch: p.branch,
    updatedAt: p.updatedAt,
    ...(customTitle ? { customTitle } : {}),
    ...(remote ? { remote } : {}),
    ...(mascot ? { mascot } : {}),
    ...(p.pinned === true ? { pinned: true } : {}),
    ...(note ? { note } : {}),
  };
}

export function fromPersistedSession(p: PersistedSession): Session {
  const session = sanitizePersistedSession(p);
  return {
    ...session,
    runState: "idle",
    connection: initialConnectionEvidence(session.remote ? "ssh" : "local", "restore"),
  };
}

export function localSessionDirs(sessions: readonly PersistedSession[]): string[] {
  return sessions.flatMap((s) => (s.remote ? [] : [s.dir]));
}

export function dedupeById<T extends { id: string; updatedAt: number }>(items: T[]): T[] {
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

function isValidSplitMode(v: unknown): v is "single" | "horizontal" | "vertical" {
  return v === "single" || v === "horizontal" || v === "vertical";
}

function isValidInspectorTab(v: unknown): v is "overview" | "changes" | "files" | "notes" {
  return v === "overview" || v === "changes" || v === "files" || v === "notes";
}

function sanitizeTrueRecord(raw: unknown): Record<string, true> {
  const out: Record<string, true> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === true && isSafeRecordKey(k)) out[k] = true;
  }
  return out;
}

function sanitizeWorkflows(raw: unknown): Workflow[] {
  if (!Array.isArray(raw)) return [];
  const out: Workflow[] = [];
  for (const item of raw) {
    const workflow = sanitizeWorkflow(item);
    if (workflow) out.push(workflow);
  }
  return out;
}

/** Keep at most the 50 most-recent command-usage entries (matches the cap in
 * the UI store's recordCommandUse) and drop any non-finite values. */
function sanitizeCommandUsage(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const entries: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isSafeRecordKey(k) && typeof v === "number" && Number.isFinite(v)) entries.push([k, v]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, 50));
}

function finiteNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function sanitizeTerminalSnapshot(raw: unknown): PersistedTerminalSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const viewportY = finiteNumber(t.viewportY);
  const baseY = finiteNumber(t.baseY);
  const cols = finiteNumber(t.cols);
  const rows = finiteNumber(t.rows);
  const capturedAt = finiteNumber(t.capturedAt);
  if (
    typeof t.serialized !== "string" ||
    viewportY === null ||
    baseY === null ||
    cols === null ||
    rows === null ||
    capturedAt === null ||
    typeof t.truncated !== "boolean" ||
    viewportY < 0 ||
    baseY < 0 ||
    cols < 1 ||
    rows < 1 ||
    capturedAt < 0
  ) {
    return null;
  }

  const serialized = t.serialized.length > MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE
    ? trimTerminalSnapshotSerialized(t.serialized, MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE)
    : t.serialized;
  return {
    serialized,
    viewportY: Math.trunc(viewportY),
    baseY: Math.trunc(baseY),
    cols: Math.trunc(cols),
    rows: Math.trunc(rows),
    capturedAt: Math.trunc(capturedAt),
    truncated: t.truncated || serialized.length !== t.serialized.length,
  };
}

export function sanitizeSnapshot(raw: unknown): WorkspaceSnapshotV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;

  const sessionsRaw = obj.sessions;
  if (!Array.isArray(sessionsRaw)) return null;
  const sessions = dedupeById(sessionsRaw.filter(isPersistedSession).map(sanitizePersistedSession));

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

    const collapsedDirs = sanitizeTrueRecord(uiRaw.collapsedDirs);
    const collapsedDiffSections = sanitizeTrueRecord(uiRaw.collapsedDiffSections);

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

    const inspectorTab = isValidInspectorTab(uiRaw.inspectorTab) ? uiRaw.inspectorTab : "overview";

    ui = { sidebarVisible, panelVisible, collapsedDirs, collapsedDiffSections, split, inspectorTab };
  } else {
    ui = { ...DEFAULT_UI_LAYOUT_V2 };
  }

  if (ui.split.mode !== "single" && activeSessionId !== ui.split.paneA && activeSessionId !== ui.split.paneB) {
    activeSessionId = ui.split.paneB ?? ui.split.paneA ?? activeSessionId;
  }

  const terminals: Record<string, PersistedTerminalSnapshot> = {};
  if (obj.terminals && typeof obj.terminals === "object") {
    const orphanTerminalIds: string[] = [];
    const terminalEntries: [string, PersistedTerminalSnapshot][] = [];
    for (const [k, v] of Object.entries(obj.terminals as Record<string, unknown>)) {
      if (!isSafeRecordKey(k) || !sessionIds.has(k)) {
        orphanTerminalIds.push(k);
        continue;
      }
      const snapshot = sanitizeTerminalSnapshot(v);
      if (snapshot) terminalEntries.push([k, snapshot]);
    }
    terminalEntries
      .sort((a, b) => b[1].capturedAt - a[1].capturedAt)
      .slice(0, MAX_TERMINAL_SNAPSHOTS)
      .forEach(([id, snapshot]) => {
        terminals[id] = snapshot;
      });
    if (orphanTerminalIds.length) {
      console.warn("[persist] dropped orphan terminal snapshots", orphanTerminalIds);
    }
  }

  const agentResume: Record<string, PersistedAgentResumeIntent> = {};
  if (obj.agentResume && typeof obj.agentResume === "object") {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    for (const [k, v] of Object.entries(obj.agentResume as Record<string, unknown>)) {
      if (!isSafeRecordKey(k) || !sessionIds.has(k)) continue;
      if (!v || typeof v !== "object") continue;
      const a = v as Record<string, unknown>;
      const owningSession = sessionsById.get(k);
      const legacyProvenance = !("provenance" in a) && owningSession
        ? owningSession.remote
          ? {
              transport: "ssh" as const,
              host: owningSession.remote.host,
              port: owningSession.remote.port,
              user: owningSession.remote.user,
              ...(owningSession.remote.identityFile
                ? { identityFile: owningSession.remote.identityFile }
                : {}),
            }
          : { transport: "local" as const }
        : null;
      const provenance = sanitizeResumeProvenance(a.provenance) ?? legacyProvenance;
      if (
        typeof a.agent === "string" &&
        typeof a.command === "string" &&
        typeof a.cwd === "string" &&
        typeof a.lastSeenAt === "number" &&
        Number.isFinite(a.lastSeenAt) &&
        provenance &&
        (a.confidence === "exact" || a.confidence === "continue" || a.confidence === "unknown")
      ) {
        agentResume[k] = {
          agent: a.agent,
          command: a.command,
          cwd: a.cwd,
          provenance,
          ...(typeof a.resumeId === "string" ? { resumeId: a.resumeId } : {}),
          lastSeenAt: a.lastSeenAt,
          confidence: a.confidence,
        };
      }
    }
  }

  const savedAt = typeof obj.savedAt === "number" && Number.isFinite(obj.savedAt) ? obj.savedAt : 0;
  const recentDirs = sanitizeRecentDirs(obj.recentDirs);
  const fallbackRecentDirs = sanitizeRecentDirs(localSessionDirs(sessions));
  const recentCommands = sanitizeRecentCommands(obj.recentCommands);
  const commandUsage = sanitizeCommandUsage(obj.commandUsage);
  const workflows = sanitizeWorkflows(obj.workflows);

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
    commandUsage,
    workflows,
  };
}
