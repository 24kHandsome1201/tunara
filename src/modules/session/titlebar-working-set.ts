import type { Session } from "../../ui/types.ts";
import type { ConnectionPhase } from "../terminal/lib/connection-state.ts";
import {
  groupSessionsForSidebar,
  localDirFromGroup,
  representativeSession,
  sidebarGroupKey,
  sshEndpointLabel,
  sshRemoteFromGroup,
  type SidebarGroup,
  type SidebarGroupKind,
} from "./sidebar-groups.ts";

/** Structural file-tab shape so this module stays free of the UI store. */
export interface TitlebarFileTabRef {
  id: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  dirty: boolean;
}

export interface TitlebarDevice {
  key: string;
  kind: SidebarGroupKind;
  label: string;
  detail: string;
  sessions: Session[];
  dirtyFiles: TitlebarFileTabRef[];
}

export interface TitlebarWorkingSetItem {
  kind: "terminal" | "file";
  id: string;
  sessionId: string;
  tab?: TitlebarFileTabRef;
}

export interface TitlebarWorkingSet {
  deviceKey: string | null;
  deviceKind: SidebarGroupKind | null;
  deviceLabel: string;
  deviceDetail: string;
  terminals: Session[];
  files: TitlebarFileTabRef[];
  showTerminals: boolean;
  showDeviceIdentity: boolean;
  showDeviceMenu: boolean;
  deviceConnectionPhase: ConnectionPhase | null;
  showOriginGlyph: boolean;
  devices: TitlebarDevice[];
  foreignDirtyCount: number;
  foreignDirtyFiles: Array<{ device: TitlebarDevice; tab: TitlebarFileTabRef }>;
}

export function titlebarDeviceKey(session: Pick<Session, "dir" | "remote">): string {
  return sidebarGroupKey(session);
}

export function titlebarDeviceCaption(group: SidebarGroup): { label: string; detail: string } {
  if (group.kind === "ssh") {
    const remote = sshRemoteFromGroup(group);
    const label = remote ? sshEndpointLabel(remote) : group.key;
    return { label, detail: label };
  }
  const dir = localDirFromGroup(group) ?? group.key.replace(/^local:/, "");
  const repo = group.sessions.find((session) => session.workspace)?.workspace?.repository.name;
  const parts = dir.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] || dir;
  return { label: repo || basename, detail: dir };
}

function deviceFromGroup(
  group: SidebarGroup,
  fileTabs: readonly TitlebarFileTabRef[],
  sessionById: ReadonlyMap<string, Session>,
): TitlebarDevice {
  const { label, detail } = titlebarDeviceCaption(group);
  const dirtyFiles = fileTabs.filter((tab) => {
    if (!tab.dirty) return false;
    const owner = sessionById.get(tab.sessionId);
    return owner !== undefined && sidebarGroupKey(owner) === group.key;
  });
  return {
    key: group.key,
    kind: group.kind,
    label,
    detail,
    sessions: group.sessions,
    dirtyFiles,
  };
}

export function titlebarWorkingSet(input: {
  sessions: readonly Session[];
  fileTabs: readonly TitlebarFileTabRef[];
  activeSessionId: string | null | undefined;
  sidebarVisible: boolean;
}): TitlebarWorkingSet {
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  const groups = groupSessionsForSidebar(input.sessions);
  const devices = groups.map((group) => deviceFromGroup(group, input.fileTabs, sessionById));
  const active = input.sessions.find((session) => session.id === input.activeSessionId)
    ?? input.sessions[0];
  const deviceKey = active ? sidebarGroupKey(active) : null;
  const current = devices.find((device) => device.key === deviceKey) ?? null;
  const files = input.fileTabs.filter((tab) => {
    const owner = sessionById.get(tab.sessionId);
    return owner !== undefined && deviceKey !== null && sidebarGroupKey(owner) === deviceKey;
  });
  const foreignDirtyFiles = devices.flatMap((device) =>
    device.key === deviceKey
      ? []
      : device.dirtyFiles.map((tab) => ({ device, tab })),
  );
  const showTerminals = !input.sidebarVisible;
  const showDeviceMenu = showTerminals && devices.length >= 2;
  const showDeviceIdentity = showDeviceMenu || (showTerminals && current?.kind === "ssh");
  const currentSession = current
    ? representativeSession(current.sessions, active?.id ?? "")
    : undefined;

  return {
    deviceKey,
    deviceKind: current?.kind ?? null,
    deviceLabel: current?.label ?? "",
    deviceDetail: current?.detail ?? "",
    terminals: current?.sessions ?? [],
    files,
    showTerminals,
    showDeviceIdentity,
    showDeviceMenu,
    deviceConnectionPhase: current?.kind === "ssh" ? currentSession?.connection?.phase ?? null : null,
    showOriginGlyph: !showDeviceIdentity,
    devices,
    foreignDirtyCount: foreignDirtyFiles.length,
    foreignDirtyFiles,
  };
}

export function titlebarWorkingSetVisible(workingSet: TitlebarWorkingSet): boolean {
  return workingSet.showTerminals || workingSet.files.length > 0;
}

export function visibleTitlebarItems(workingSet: TitlebarWorkingSet): TitlebarWorkingSetItem[] {
  const items: TitlebarWorkingSetItem[] = [];
  if (workingSet.showTerminals) {
    for (const session of workingSet.terminals) {
      items.push({ kind: "terminal", id: session.id, sessionId: session.id });
    }
  }
  for (const tab of workingSet.files) {
    items.push({ kind: "file", id: tab.id, sessionId: tab.sessionId, tab });
  }
  return items;
}

/** Terminals + files of the current device, including terminals hidden while the sidebar is open. */
export function cycleTitlebarItems(workingSet: TitlebarWorkingSet): TitlebarWorkingSetItem[] {
  return [
    ...workingSet.terminals.map((session) => ({
      kind: "terminal" as const,
      id: session.id,
      sessionId: session.id,
    })),
    ...workingSet.files.map((tab) => ({
      kind: "file" as const,
      id: tab.id,
      sessionId: tab.sessionId,
      tab,
    })),
  ];
}

export function titlebarItemId(item: TitlebarWorkingSetItem): string {
  return item.kind === "terminal" ? `terminal:${item.id}` : `file:${item.id}`;
}

export function filesOnSameDevice(
  tab: Pick<TitlebarFileTabRef, "id" | "sessionId">,
  fileTabs: readonly TitlebarFileTabRef[],
  sessions: readonly Session[],
): TitlebarFileTabRef[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const owner = sessionById.get(tab.sessionId);
  if (!owner) return [];
  const key = sidebarGroupKey(owner);
  return fileTabs.filter((candidate) => {
    const session = sessionById.get(candidate.sessionId);
    return session !== undefined && sidebarGroupKey(session) === key;
  });
}

export function focusTitlebarDeviceSessionId(
  deviceKey: string,
  sessions: readonly Session[],
  activeSessionId: string | null | undefined,
): string | null {
  const group = groupSessionsForSidebar(sessions).find((candidate) => candidate.key === deviceKey);
  if (!group) return null;
  return representativeSession(group.sessions, activeSessionId ?? "")?.id ?? null;
}
