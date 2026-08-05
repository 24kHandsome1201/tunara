export const SSH_DIAGNOSTIC_STAGES = ["DNS", "TCP", "handshake", "hostKey", "auth", "jump", "target", "openShell", "SFTP", "transfer", "forward", "reconnect"] as const;
export type SshDiagnosticStage = typeof SSH_DIAGNOSTIC_STAGES[number];
export const SSH_DIAGNOSTIC_CODES = ["ok", "invalidRequest", "dnsFailed", "connectionRefused", "timeout", "hostKeyRejected", "authenticationFailed", "transportClosed", "unsupported", "internal"] as const;
export type SshErrorCode = typeof SSH_DIAGNOSTIC_CODES[number];
export interface SessionBindingV1 { logicalSessionId: string; physicalPtyId: number; transportGeneration: string; }
export interface SshDiagnosticV1 { schemaVersion: 1; stage: SshDiagnosticStage; code: SshErrorCode; severity: "info" | "warning" | "error"; retryable: boolean; hopRole: "direct" | "jump" | "target"; timestamp: number; binding?: SessionBindingV1; safeContext?: Record<string, boolean | number | string>; }
export interface SshDiagnosticEventV1 { requestId: string; status: "passed" | "failed" | "skipped"; diagnostic: SshDiagnosticV1; }
export interface SshDiagnosticRequestV1 { requestId: string; sessionId: string; host: string; port?: number; }
export interface DiagnosticReportV1 { schemaVersion: 1; topology: { session: "SESSION_1"; endpoint: "HOST_1"; user: "USER_1"; path: "PATH_1"; }; events: SshDiagnosticEventV1[]; }
