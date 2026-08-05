import type { SshFailureReason } from "../../ssh/failure-reason.ts";
import type { Session } from "@/ui/types";
import type { SessionBindingV1 } from "./pty-bridge";

export type ConnectionTransport = "local" | "ssh";

export type ConnectionPhase =
  | "pending"
  | "opening"
  | "connecting"
  | "verifyingHostKey"
  | "handshaking"
  | "authenticating"
  | "openingShell"
  | "reconnecting"
  | "needsUserAction"
  | "ready"
  | "disconnected"
  | "failed"
  | "exited";

export type BackendConnectionPhase =
  | "connecting"
  | "handshaking"
  | "authenticating"
  | "openingShell"
  | "ready";

export type ConnectionEvidenceSource =
  | "user"
  | "restore"
  | "renderer"
  | "backend"
  | "hostKey"
  | "transport";

export type ConnectionFailureReason = SshFailureReason | "pty" | "cancelled";

export interface ConnectionEvidence {
  transport: ConnectionTransport;
  phase: ConnectionPhase;
  source: ConnectionEvidenceSource;
  updatedAt: number;
  reason?: ConnectionFailureReason;
  detail?: string;
  exitCode?: number;
  failedAtPhase?: Exclude<ConnectionPhase, "failed">;
}

export type ConnectionRemediation = {
  kind: "credentials" | "hostKey" | "reconnect";
  sessionId: string;
  endpoint: string;
} & (
  | { source: "binding"; binding: { logicalSessionId: string; physicalPtyId: number; transportGeneration: string } }
  | { source: "reconnect"; lifecycle: number }
);

/** Returns the authoritative binding only while the current SSH lifecycle is ready. */
export function readyBindingForSession(session: Session | undefined): SessionBindingV1 | null {
  return session?.remote
    && session.ptyId !== undefined
    && session.transportGeneration
    && session.connection?.phase === "ready"
    ? {
        logicalSessionId: session.id,
        physicalPtyId: session.ptyId,
        transportGeneration: session.transportGeneration,
      }
    : null;
}

/** Derives an action only from the session's current generation. Callers must
 * re-derive immediately before execution; retaining this value is unsafe. */
export function remediationForSession(session: Session): ConnectionRemediation | null {
  if (!session.remote || session.connection?.phase !== "needsUserAction") return null;
  const proof = session.ptyId !== undefined && session.transportGeneration
    ? { source: "binding" as const, binding: { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration } }
    : session.sshReconnectLifecycle !== undefined
      ? { source: "reconnect" as const, lifecycle: session.sshReconnectLifecycle }
      : null;
  if (!proof) return null;
  const source = {
    sessionId: session.id,
    endpoint: `${session.remote.user}@${session.remote.host}:${session.remote.port}`,
    ...proof,
  };
  return session.connection.reason === "hostKey"
    ? { kind: "hostKey", ...source }
    : session.connection.reason === "auth"
      ? { kind: "credentials", ...source }
      : { kind: "reconnect", ...source };
}

export function remediationIsCurrent(session: Session, remediation: ConnectionRemediation): boolean {
  const current = remediationForSession(session);
  if (!current || current.kind !== remediation.kind || current.sessionId !== remediation.sessionId || current.endpoint !== remediation.endpoint || current.source !== remediation.source) return false;
  return current.source === "binding" && remediation.source === "binding"
    ? current.binding.logicalSessionId === remediation.binding.logicalSessionId
      && current.binding.physicalPtyId === remediation.binding.physicalPtyId
      && current.binding.transportGeneration === remediation.binding.transportGeneration
    : current.source === "reconnect" && remediation.source === "reconnect" && current.lifecycle === remediation.lifecycle;
}

export type ConnectionEvent =
  | { type: "queued"; transport: ConnectionTransport; source?: "user" | "restore" }
  | { type: "openRequested"; transport: ConnectionTransport; source?: "user" | "renderer" }
  | { type: "reconnectRequested" }
  | { type: "transportLost" }
  | { type: "reconnectScheduled" }
  | { type: "needsUserAction"; reason: ConnectionFailureReason }
  | { type: "backendPhase"; transport: "ssh"; phase: BackendConnectionPhase }
  | { type: "hostKeyPrompt" }
  | { type: "ready"; transport: ConnectionTransport; source?: "renderer" | "backend" }
  | {
      type: "failed";
      transport: ConnectionTransport;
      reason: ConnectionFailureReason;
      detail?: string;
      source?: "renderer" | "backend";
    }
  | { type: "exit"; transport: ConnectionTransport; code: number; disconnected?: boolean };

function compactDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const compact = detail.replace(/[\r\n]+/g, " ").trim();
  if (!compact) return undefined;
  return compact.slice(0, 500);
}

function sameEvidence(a: ConnectionEvidence | undefined, b: ConnectionEvidence): boolean {
  return !!a
    && a.transport === b.transport
    && a.phase === b.phase
    && a.source === b.source
    && a.reason === b.reason
    && a.detail === b.detail
    && a.exitCode === b.exitCode
    && a.failedAtPhase === b.failedAtPhase;
}

export function reduceConnectionEvidence(
  current: ConnectionEvidence | undefined,
  event: ConnectionEvent,
  now = Date.now(),
): ConnectionEvidence {
  let next: ConnectionEvidence;
  switch (event.type) {
    case "queued":
      next = {
        transport: event.transport,
        phase: "pending",
        source: event.source ?? "user",
        updatedAt: now,
      };
      break;
    case "openRequested":
      next = {
        transport: event.transport,
        phase: event.transport === "ssh" ? "connecting" : "opening",
        source: event.source ?? "renderer",
        updatedAt: now,
      };
      break;
    case "reconnectRequested":
    case "reconnectScheduled":
      next = {
        transport: "ssh",
        phase: "reconnecting",
        source: "user",
        updatedAt: now,
      };
      break;
    case "transportLost":
      next = {
        transport: "ssh",
        phase: "disconnected",
        source: "transport",
        updatedAt: now,
        exitCode: -2,
      };
      break;
    case "needsUserAction":
      next = {
        transport: "ssh",
        phase: "needsUserAction",
        source: "user",
        updatedAt: now,
        reason: event.reason,
      };
      break;
    case "backendPhase":
      next = {
        transport: "ssh",
        phase: event.phase,
        source: "backend",
        updatedAt: now,
      };
      break;
    case "hostKeyPrompt":
      next = {
        transport: "ssh",
        phase: "verifyingHostKey",
        source: "hostKey",
        updatedAt: now,
      };
      break;
    case "ready":
      next = {
        transport: event.transport,
        phase: "ready",
        source: event.source ?? "renderer",
        updatedAt: now,
      };
      break;
    case "failed": {
      const detail = compactDetail(event.detail);
      const failedAtPhase = current?.phase === "failed"
        ? current.failedAtPhase
        : current?.phase;
      next = {
        transport: event.transport,
        phase: "failed",
        source: event.source ?? "renderer",
        updatedAt: now,
        reason: event.reason,
        ...(detail ? { detail } : {}),
        ...(failedAtPhase ? { failedAtPhase } : {}),
      };
      break;
    }
    case "exit":
      next = {
        transport: event.transport,
        phase: event.disconnected ? "disconnected" : "exited",
        source: "transport",
        updatedAt: now,
        exitCode: event.code,
      };
      break;
  }
  return sameEvidence(current, next) ? current! : next;
}

export function initialConnectionEvidence(
  transport: ConnectionTransport,
  source: "user" | "restore" = "user",
  now = Date.now(),
): ConnectionEvidence {
  return reduceConnectionEvidence(undefined, { type: "queued", transport, source }, now);
}

export function connectionDiagnostic(input: {
  sessionId: string;
  endpoint?: string;
  authMethod?: string;
  evidence?: ConnectionEvidence;
}): string {
  const evidence = input.evidence;
  const rows = [
    `session=${input.sessionId ? "SESSION_1" : "unknown"}`,
    `endpoint=${input.endpoint ? "HOST_1" : "local"}`,
    `transport=${evidence?.transport ?? "unknown"}`,
    ...(input.authMethod ? [`authMethod=${input.authMethod}`] : []),
    `phase=${evidence?.phase ?? "unknown"}`,
    `source=${evidence?.source ?? "unknown"}`,
    `updatedAt=${evidence ? new Date(evidence.updatedAt).toISOString() : "unknown"}`,
  ];
  if (evidence?.reason) rows.push(`reason=${evidence.reason}`);
  if (evidence?.failedAtPhase) rows.push(`failedAtPhase=${evidence.failedAtPhase}`);
  if (evidence?.exitCode !== undefined) rows.push(`exitCode=${evidence.exitCode}`);
  return rows.join("\n");
}
