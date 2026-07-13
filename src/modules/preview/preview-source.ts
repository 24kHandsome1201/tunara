import type { WorkspaceContext } from "../git/git-bridge.ts";
import { currentWorkspaceWorktree } from "../git/workspace-context.ts";
import { findTerminalUrlTokens } from "../terminal/lib/terminal-quick-select.ts";
import { stripTerminalControlSequences } from "../terminal/lib/terminal-utils.ts";

export type PreviewSourceTransport = "local" | "ssh";
export type PreviewPermission = "eligible" | "remote-manual";
export type PreviewSourceState = "active" | "stale";
export const MAX_PREVIEW_SOURCES_PER_SESSION = 64;

export interface PreviewSourceContext {
  repositoryId: string;
  worktreeId: string;
  workspaceId: string;
  sessionId: string;
  terminalId: string;
  physicalPtyId?: number;
  transport: PreviewSourceTransport;
  workspaceResolution: "resolved" | "fallback";
}

export interface PreviewCommandProvenance {
  generation: string;
  sequence: number;
  command: string;
  submittedAt: number;
}

export interface PreviewSource extends PreviewSourceContext {
  sourceUrl: string;
  discoveredAt: number;
  permission: PreviewPermission;
  state: PreviewSourceState;
  staleReason?: "terminal-exited" | "session-closed";
  restartProvenance?: PreviewCommandProvenance;
}

export interface PreviewSourceSession {
  id: string;
  dir: string;
  reconnectNonce?: number;
  ptyId?: number;
  remote?: { host: string; port: number; user: string };
  workspace?: WorkspaceContext;
}

function fallbackIdentity(session: PreviewSourceSession): string {
  const transport = session.remote ? "ssh" : "local";
  const authority = session.remote
    ? `${session.remote.user}@${session.remote.host}:${session.remote.port}`
    : "local";
  return `fallback:${transport}:${authority}:${session.dir}`;
}

export function previewSourceContext(session: PreviewSourceSession): PreviewSourceContext {
  const worktree = currentWorkspaceWorktree(session.workspace);
  const fallback = fallbackIdentity(session);
  const repositoryId = session.workspace?.repository.id ?? fallback;
  const worktreeId = worktree?.id ?? fallback;
  return {
    repositoryId,
    worktreeId,
    workspaceId: `${repositoryId}::${worktreeId}`,
    sessionId: session.id,
    terminalId: `${session.id}:${session.reconnectNonce ?? 0}`,
    ...(session.ptyId === undefined ? {} : { physicalPtyId: session.ptyId }),
    transport: session.remote ? "ssh" : "local",
    workspaceResolution: session.workspace && worktree ? "resolved" : "fallback",
  };
}

export function normalizePreviewCandidate(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") return null;
    if (url.port) {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function previewSourceKey(source: Pick<PreviewSource, "repositoryId" | "worktreeId" | "workspaceId" | "sessionId" | "terminalId" | "sourceUrl">): string {
  return [
    source.repositoryId,
    source.worktreeId,
    source.workspaceId,
    source.sessionId,
    source.terminalId,
    source.sourceUrl,
  ].join("\u0000");
}

export function detectPreviewSources(
  output: string,
  context: PreviewSourceContext,
  discoveredAt = Date.now(),
  restartProvenance?: PreviewCommandProvenance,
): PreviewSource[] {
  const seen = new Set<string>();
  const detected: PreviewSource[] = [];
  for (const raw of findTerminalUrlTokens(stripTerminalControlSequences(output))) {
    const sourceUrl = normalizePreviewCandidate(raw);
    if (!sourceUrl) continue;
    const source: PreviewSource = {
      ...context,
      sourceUrl,
      discoveredAt,
      permission: context.transport === "local" ? "eligible" : "remote-manual",
      state: "active",
      ...(restartProvenance ? { restartProvenance } : {}),
    };
    const key = previewSourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    detected.push(source);
  }
  return detected;
}

export function mergePreviewSources(
  current: readonly PreviewSource[],
  incoming: readonly PreviewSource[],
  limit = MAX_PREVIEW_SOURCES_PER_SESSION,
): PreviewSource[] {
  const byKey = new Map(current.map((source) => [previewSourceKey(source), source]));
  for (const source of incoming) {
    const key = previewSourceKey(source);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, source);
    } else if (source.restartProvenance
      && source.restartProvenance.generation !== existing.restartProvenance?.generation) {
      byKey.set(key, { ...source, discoveredAt: existing.discoveredAt });
    }
  }
  return [...byKey.values()].slice(-Math.max(0, limit));
}

export function markPreviewSourcesStale(
  current: readonly PreviewSource[],
  terminalId: string,
  staleReason: PreviewSource["staleReason"] = "terminal-exited",
): PreviewSource[] {
  return current.map((source) => source.terminalId === terminalId && source.state === "active"
    ? { ...source, state: "stale", staleReason }
    : source);
}

export function createPreviewOutputScanner(onOutput: (text: string) => void) {
  const decoder = new TextDecoder();
  let unfinishedToken = "";
  const MAX_UNFINISHED_TOKEN_CHARS = 4096;

  const emitCompletedText = (decoded: string) => {
    let boundary = -1;
    for (let index = decoded.length - 1; index >= 0; index -= 1) {
      if (/\s/.test(decoded[index])) {
        boundary = index + 1;
        break;
      }
    }
    if (boundary < 0) {
      // A development URL should never require an unbounded terminal token.
      // Drop pathological non-whitespace output instead of repeatedly scanning
      // it or retaining arbitrary terminal history on the hot output path.
      const combined = unfinishedToken + decoded;
      unfinishedToken = combined.length <= MAX_UNFINISHED_TOKEN_CHARS ? combined : "";
      return;
    }
    const completed = unfinishedToken + decoded.slice(0, boundary);
    unfinishedToken = decoded.slice(boundary);
    if (completed) onOutput(completed);
  };

  return {
    push(bytes: Uint8Array) {
      const decoded = decoder.decode(bytes, { stream: true });
      if (decoded) emitCompletedText(decoded);
    },
    dispose() {
      const tail = decoder.decode();
      const finalText = unfinishedToken + tail;
      if (finalText) onOutput(finalText);
      unfinishedToken = "";
    },
  };
}
