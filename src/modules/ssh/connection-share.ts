export interface SshEndpointIdentity {
  host: string;
  port: number;
  user: string;
  identityFile?: string;
  jump?: { host: string; port: number; user: string };
}

interface RemoteLike extends SshEndpointIdentity {
  route?: { jump?: { host: string; port: number; user: string } };
}

interface SessionLike {
  id: string;
  dir: string;
  remote?: RemoteLike;
  ptyId?: number;
  transportGeneration?: string;
  runState?: string;
  connection?: { phase?: string };
}

export function sshEndpointIdentityFromRemote(remote: RemoteLike): SshEndpointIdentity {
  return {
    host: remote.host,
    port: remote.port,
    user: remote.user,
    ...(remote.identityFile ? { identityFile: remote.identityFile } : {}),
    ...(remote.route?.jump
      ? { jump: { host: remote.route.jump.host, port: remote.route.jump.port, user: remote.route.jump.user } }
      : {}),
  };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function sameOptional(a?: string, b?: string): boolean {
  return (a ?? "") === (b ?? "");
}

export function sameSshEndpoint(a: SshEndpointIdentity, b: SshEndpointIdentity): boolean {
  if (normalizeHost(a.host) !== normalizeHost(b.host) || a.port !== b.port || a.user !== b.user) return false;
  if (!sameOptional(a.identityFile, b.identityFile)) return false;
  if (!a.jump && !b.jump) return true;
  if (!a.jump || !b.jump) return false;
  return normalizeHost(a.jump.host) === normalizeHost(b.jump.host)
    && a.jump.port === b.jump.port
    && a.jump.user === b.jump.user;
}

export function isLiveShareableSshSession(session: SessionLike): boolean {
  return Boolean(
    session.remote
      && session.ptyId
      && session.transportGeneration
      && session.connection?.phase === "ready"
      && session.runState !== "failed",
  );
}

/** Prefer an already-authenticated sibling so a new pane can reuse the TCP transport. */
export function findShareableSshSession(
  sessions: readonly SessionLike[],
  target: SshEndpointIdentity,
  excludeSessionId?: string,
): SessionLike | null {
  for (const session of sessions) {
    if (session.id === excludeSessionId || !session.remote || !isLiveShareableSshSession(session)) continue;
    if (sameSshEndpoint(sshEndpointIdentityFromRemote(session.remote), target)) return session;
  }
  return null;
}

export function shareWithLogicalSessionIdFor(
  sessions: readonly SessionLike[],
  remote: RemoteLike | undefined,
  excludeSessionId: string,
): string | undefined {
  if (!remote) return undefined;
  return findShareableSshSession(sessions, sshEndpointIdentityFromRemote(remote), excludeSessionId)?.id;
}

export function duplicateRemoteSessionFields(session: SessionLike): { dir: string; remote: RemoteLike } | null {
  if (!session.remote) return null;
  return {
    dir: session.dir,
    remote: { ...session.remote },
  };
}
