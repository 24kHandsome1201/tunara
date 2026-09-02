import type { ConnectionPhase } from "../terminal/lib/connection-state.ts";
import { deriveTitle, type RemoteInfo, type Session } from "../../ui/types.ts";

export type SidebarGroupKind = "local" | "ssh";

export interface SidebarGroup {
  key: string;
  kind: SidebarGroupKind;
  sessions: Session[];
}

export interface SshEndpointRef {
  user: string;
  host: string;
  port: number;
}

/** Host identity for sidebar grouping. Jump route and key path are connection details, not group identity. */
export function sshEndpointLabel(remote: SshEndpointRef): string {
  return remote.port === 22
    ? `${remote.user}@${remote.host}`
    : `${remote.user}@${remote.host}:${remote.port}`;
}

export function sidebarGroupKeyFromEndpoint(remote: SshEndpointRef): string {
  return `ssh:${remote.user}@${remote.host.trim().toLowerCase()}:${remote.port}`;
}

export function sidebarGroupKey(session: Pick<Session, "dir" | "remote">): string {
  if (session.remote) return sidebarGroupKeyFromEndpoint(session.remote);
  return `local:${session.dir}`;
}

/** OSC 7 rewrites SSH `dir` to an absolute POSIX path; anything else is still the user@host label. */
export function knownRemoteCwd(dir: string): string | null {
  const trimmed = dir.trim();
  return trimmed.startsWith("/") ? trimmed : null;
}

export function sidebarCwdLabel(session: Pick<Session, "dir" | "remote">): string {
  if (!session.remote) {
    const parts = session.dir.split("/");
    return parts[parts.length - 1] || session.dir;
  }
  const cwd = knownRemoteCwd(session.dir);
  if (!cwd) return session.dir;
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

export function groupSessionsForSidebar(sessions: readonly Session[]): SidebarGroup[] {
  const groups = new Map<string, SidebarGroup>();
  for (const session of sessions) {
    const key = sidebarGroupKey(session);
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    groups.set(key, {
      key,
      kind: session.remote ? "ssh" : "local",
      sessions: [session],
    });
  }
  return [...groups.values()];
}

export function sessionMatchesSidebarSearch(session: Session, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { primary, subtitle } = deriveTitle(session);
  if (primary.toLowerCase().includes(q) || subtitle.toLowerCase().includes(q)) return true;
  if (session.dir.toLowerCase().includes(q)) return true;
  const remote = session.remote;
  if (!remote) return false;
  const haystack = [
    remote.user,
    remote.host,
    String(remote.port),
    sshEndpointLabel(remote),
    sidebarGroupKeyFromEndpoint(remote),
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

export function representativeSession(
  sessions: readonly Session[],
  activeSessionId: string,
): Session | undefined {
  const active = sessions.find((session) => session.id === activeSessionId);
  if (active) return active;
  return sessions.reduce<Session | undefined>(
    (latest, session) => !latest || session.updatedAt >= latest.updatedAt ? session : latest,
    undefined,
  );
}

export function liveSessionsOnEndpoint(
  sessions: readonly Session[],
  endpoint: SshEndpointRef,
): Session[] {
  const key = sidebarGroupKeyFromEndpoint(endpoint);
  return sessions.filter((session) => sidebarGroupKey(session) === key);
}

export function sshCardConnectionPhase(
  session: Pick<Session, "remote" | "connection">,
): ConnectionPhase | null {
  if (!session.remote) return null;
  const phase = session.connection?.phase;
  if (!phase || phase === "ready") return null;
  return phase;
}

export function sshConnectionPhaseTone(
  phase: ConnectionPhase,
): "error" | "warning" | "progress" {
  if (phase === "failed" || phase === "disconnected" || phase === "exited") return "error";
  if (phase === "needsUserAction" || phase === "verifyingHostKey") return "warning";
  return "progress";
}

export function localDirFromGroup(group: Pick<SidebarGroup, "kind" | "sessions">): string | null {
  if (group.kind !== "local" || group.sessions.length === 0) return null;
  return group.sessions[0]?.dir ?? null;
}

/** Compact titlebar caption: `alice@prod` or `alice@prod · /etc/nginx`. */
export function titlebarDeviceCaption(group: SidebarGroup): { label: string; detail: string } {
  if (group.kind === "ssh") {
    const remote = sshRemoteFromGroup(group);
    const endpoint = remote ? sshEndpointLabel(remote) : group.key;
    const cwd = group.sessions.map((session) => knownRemoteCwd(session.dir)).find(Boolean) ?? null;
    return { label: cwd ? `${endpoint} · ${cwd}` : endpoint, detail: cwd ? `${endpoint} · ${cwd}` : endpoint };
  }
  const dir = localDirFromGroup(group) ?? group.key.replace(/^local:/, "");
  const repo = group.sessions.find((session) => session.workspace)?.workspace?.repository.name;
  const parts = dir.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] || dir;
  return { label: repo || basename, detail: dir };
}

export function sshRemoteFromGroup(group: Pick<SidebarGroup, "kind" | "sessions">): RemoteInfo | null {
  if (group.kind !== "ssh") return null;
  return group.sessions.find((session) => session.remote)?.remote ?? null;
}
