// One-shot, in-memory SSH credentials (password / key passphrase) for a single
// connection attempt. Kept OUT of the Session object and the persisted snapshot
// so credentials are never written to disk — Tunara's zero-credential-storage
// promise. SshConnect stashes them keyed by session id; TerminalView consumes
// (and deletes) them once when it opens the PTY.

import type { RemoteInfo, Session } from "@/ui/types";

export interface PendingSshCredentials {
  password?: string;
  keyPassphrase?: string;
}

const pending = new Map<string, PendingSshCredentials>();

export interface PendingSshReconnect {
  remote: RemoteInfo;
  credentials: PendingSshCredentials;
}

const pendingReconnects = new Map<string, PendingSshReconnect>();

const LIVE_SSH_PHASES = new Set([
  "ready",
  "connecting",
  "verifyingHostKey",
  "handshaking",
  "authenticating",
  "openingShell",
]);

export function stashSshCredentials(sessionId: string, creds: PendingSshCredentials): void {
  // Only store if at least one secret is present; otherwise nothing to keep.
  if (creds.password || creds.keyPassphrase) {
    pending.set(sessionId, creds);
  }
}

/**
 * Take (and remove) the one-shot credentials for a session, if any.
 *
 * NOTE: consumed on the FIRST PTY-open attempt, before knowing whether the
 * connection succeeded. This matches the "credentials for a single attempt"
 * security model — a typo'd password or rejected host key burns them, and there
 * is no re-entry to supply new ones for an existing session (SshConnect only
 * creates new sessions). That's an accepted usability trade-off for never
 * holding credentials longer than one attempt.
 */
export function takeSshCredentials(sessionId: string): PendingSshCredentials | undefined {
  const creds = pending.get(sessionId);
  if (creds) pending.delete(sessionId);
  return creds;
}

/** A published SSH PTY can be replaced without remounting its terminal. */
export function hasLiveSshPty(session: Session): boolean {
  return Boolean(
    session.remote
    && session.ptyId !== undefined
    && LIVE_SSH_PHASES.has(session.connection?.phase ?? ""),
  );
}

/** Stage a replacement without mutating the live session or persisting secrets. */
export function stashSshReconnect(sessionId: string, reconnect: PendingSshReconnect): void {
  pendingReconnects.set(sessionId, reconnect);
}

export function takeSshReconnect(sessionId: string): PendingSshReconnect | undefined {
  const reconnect = pendingReconnects.get(sessionId);
  if (reconnect) pendingReconnects.delete(sessionId);
  return reconnect;
}

/** Drop credentials when a session is removed before its first PTY open. */
export function clearSshCredentials(sessionId: string): void {
  pending.delete(sessionId);
  pendingReconnects.delete(sessionId);
}
