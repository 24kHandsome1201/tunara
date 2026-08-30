import {
  SSH_DIAGNOSTIC_CODES,
  SSH_DIAGNOSTIC_STAGES,
  type SshDiagnosticEventV1,
  type SshDiagnosticStage,
  type SshErrorCode,
} from "./diagnostics-schema";

const sessions = new Map<string, SshDiagnosticEventV1[]>();

const SAFE_CONTEXT_KEYS = new Set(["addressCount", "addressFamily", "attempt", "port", "timeoutMs"]);

/** Defense in depth at the renderer boundary: only allowlisted scalar context is retained. */
export function sanitizeDiagnosticEvent(event: SshDiagnosticEventV1): SshDiagnosticEventV1 {
  const safeContext = Object.fromEntries(Object.entries(event.diagnostic.safeContext ?? {})
    .filter(([key, value]) => SAFE_CONTEXT_KEYS.has(key)
      && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))));
  return {
    requestId: event.requestId,
    status: event.status,
    diagnostic: {
      schemaVersion: 1,
      stage: SSH_DIAGNOSTIC_STAGES.includes(event.diagnostic.stage) ? event.diagnostic.stage : "target",
      code: SSH_DIAGNOSTIC_CODES.includes(event.diagnostic.code) ? event.diagnostic.code : "internal",
      severity: ["info", "warning", "error"].includes(event.diagnostic.severity) ? event.diagnostic.severity : "error",
      retryable: event.diagnostic.retryable === true,
      hopRole: ["direct", "jump", "target"].includes(event.diagnostic.hopRole) ? event.diagnostic.hopRole : "direct",
      timestamp: Number.isFinite(event.diagnostic.timestamp) ? event.diagnostic.timestamp : Date.now(),
      binding: event.diagnostic.binding ? {
        logicalSessionId: event.diagnostic.binding.logicalSessionId,
        physicalPtyId: event.diagnostic.binding.physicalPtyId,
        transportGeneration: event.diagnostic.binding.transportGeneration,
      } : undefined,
      ...(Object.keys(safeContext).length ? { safeContext } : { safeContext: undefined }),
    },
  };
}

export function appendDiagnostic(sessionId: string, event: SshDiagnosticEventV1): void {
  const list = [...(sessions.get(sessionId) ?? []), sanitizeDiagnosticEvent(event)].slice(-100);
  sessions.delete(sessionId);
  sessions.set(sessionId, list);
  while ([...sessions.values()].reduce((n, values) => n + values.length, 0) > 500) {
    const first = sessions.keys().next().value as string | undefined;
    if (!first) break;
    const values = sessions.get(first)!;
    values.shift();
    if (!values.length) sessions.delete(first);
  }
}

/** Lifecycle seam used by connect/transfer/forward owners without retaining backend error text. */
export function recordSshLifecycleDiagnostic(
  sessionId: string,
  stage: SshDiagnosticStage,
  status: SshDiagnosticEventV1["status"],
  code: SshErrorCode,
  binding?: SshDiagnosticEventV1["diagnostic"]["binding"],
): void {
  appendDiagnostic(sessionId, {
    requestId: "lifecycle",
    status,
    diagnostic: {
      schemaVersion: 1,
      stage,
      code,
      severity: status === "failed" ? "error" : "info",
      retryable: status === "failed" && code !== "hostKeyRejected" && code !== "authenticationFailed",
      hopRole: "direct",
      timestamp: Date.now(),
      binding,
    },
  });
}

export const diagnosticsForSession = (id: string): readonly SshDiagnosticEventV1[] => [...(sessions.get(id) ?? [])];
export function clearDiagnostics(): void { sessions.clear(); }
