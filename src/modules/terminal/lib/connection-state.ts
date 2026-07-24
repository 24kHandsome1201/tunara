import type { SshFailureReason } from "../../ssh/failure-reason.ts";

export type ConnectionTransport = "local" | "ssh";

export type ConnectionPhase =
  | "pending"
  | "opening"
  | "connecting"
  | "verifyingHostKey"
  | "handshaking"
  | "authenticating"
  | "openingShell"
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

export type ConnectionEvent =
  | { type: "queued"; transport: ConnectionTransport; source?: "user" | "restore" }
  | { type: "openRequested"; transport: ConnectionTransport; source?: "user" | "renderer" }
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
    `session=${input.sessionId}`,
    `endpoint=${input.endpoint ?? "local"}`,
    `transport=${evidence?.transport ?? "unknown"}`,
    ...(input.authMethod ? [`authMethod=${input.authMethod}`] : []),
    `phase=${evidence?.phase ?? "unknown"}`,
    `source=${evidence?.source ?? "unknown"}`,
    `updatedAt=${evidence ? new Date(evidence.updatedAt).toISOString() : "unknown"}`,
  ];
  if (evidence?.reason) rows.push(`reason=${evidence.reason}`);
  if (evidence?.failedAtPhase) rows.push(`failedAtPhase=${evidence.failedAtPhase}`);
  if (evidence?.exitCode !== undefined) rows.push(`exitCode=${evidence.exitCode}`);
  if (evidence?.detail) rows.push(`detail=${evidence.detail}`);
  return rows.join("\n");
}
