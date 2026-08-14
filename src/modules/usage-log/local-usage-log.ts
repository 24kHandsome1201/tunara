import { invoke } from "@tauri-apps/api/core";

export type LocalUsageEventName =
  | "ssh.session.created"
  | "ssh.session.open_requested"
  | "ssh.session.opened"
  | "ssh.session.open_failed"
  | "ssh.session.closed"
  | "ssh.connection.phase"
  | "ssh.host_key.prompted"
  | "ssh.host_key.decided"
  | "ssh.host_key.persistence"
  | "ssh.reconnect.scheduled"
  | "ssh.reconnect.started"
  | "ssh.reconnect.completed"
  | "ssh.reconnect.failed"
  | "ssh.disconnected"
  | "ssh.terminal.command_started"
  | "ssh.terminal.command_finished"
  | "ssh.files.operation"
  | "ssh.transfer.queued"
  | "ssh.transfer.finished"
  | "ssh.transfer.cancelled"
  | "ssh.transfer.retry"
  | "ssh.transfer.recovery"
  | "ssh.preview.action";

export type LocalUsageErrorCategory =
  | "auth"
  | "host_key"
  | "connect"
  | "timeout"
  | "cancelled"
  | "disconnected"
  | "stale_binding"
  | "io"
  | "permission"
  | "conflict"
  | "unsupported"
  | "internal"
  | "unknown";

export type LocalUsageOutcome =
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "scheduled"
  | "needs_user_action"
  | "outcome_unknown"
  | "skipped"
  | "accepted"
  | "rejected"
  | "saved"
  | "session_only"
  | "durability_unknown";

export interface LocalUsageEventRequest {
  event: LocalUsageEventName;
  sessionId?: string;
  correlationId?: string;
  durationMs?: number;
  success?: boolean;
  outcome?: LocalUsageOutcome;
  errorCategory?: LocalUsageErrorCategory;
  attributes?: Record<string, string>;
}

export interface LocalUsageLogStatus {
  enabled: boolean;
  directory: string;
  fileCount: number;
  totalBytes: number;
  retentionDays: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

let runtimeEnabled = false;

/** Hydration-only synchronization with the native state initialized from TOML. */
export function hydrateLocalUsageLoggingEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** Disable renderer emission before native disable, and enable only after native success. */
export async function setLocalUsageLoggingEnabled(enabled: boolean): Promise<LocalUsageLogStatus> {
  const previous = runtimeEnabled;
  if (!enabled) runtimeEnabled = false;
  try {
    const status = await invoke<LocalUsageLogStatus>("local_usage_log_set_enabled", { enabled });
    runtimeEnabled = status.enabled;
    return status;
  } catch (error) {
    // A failed enable keeps the prior state. A failed disable remains
    // renderer-disabled (fail closed), because native may have applied the
    // state change before a status/readback error crossed IPC.
    runtimeEnabled = enabled ? previous : false;
    throw error;
  }
}

export function localUsageLogStatus(): Promise<LocalUsageLogStatus> {
  return invoke<LocalUsageLogStatus>("local_usage_log_status");
}

export function ensureLocalUsageLogDirectory(): Promise<string> {
  return invoke<string>("local_usage_log_ensure_directory");
}

export function clearLocalUsageLogs(): Promise<LocalUsageLogStatus> {
  return invoke<LocalUsageLogStatus>("local_usage_log_clear");
}

export function exportLocalUsageLogs(destination: string): Promise<number> {
  return invoke<number>("local_usage_log_export", { destination });
}

/** Fire-and-forget by design: logging must never affect the owning workflow. */
export function recordLocalUsageEvent(request: LocalUsageEventRequest): void {
  if (!runtimeEnabled) return;
  void invoke("local_usage_log_record", { request }).catch(() => {
    // Native validation, rotation, and disk failures are intentionally isolated.
  });
}

export function localUsageDuration(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
}

export function localUsageAuthMethod(method: string | undefined): string {
  if (method === "agent" || method === "key" || method === "password") return method;
  if (method === "keyboardInteractive") return "keyboard_interactive";
  return "unknown";
}

export function localUsagePhase(phase: string): string {
  return phase.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`);
}

export function localUsageErrorCategory(error: unknown): LocalUsageErrorCategory {
  const value = typeof error === "string"
    ? error.toLowerCase()
    : error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "object" && error !== null && "diagnostic" in error
        ? String((error as { diagnostic?: { code?: unknown } }).diagnostic?.code ?? "").toLowerCase()
        : "";
  if (value.includes("auth") || value.includes("password") || value.includes("passphrase") || value.includes("agent")) return "auth";
  if (value.includes("hostkey") || value.includes("host key")) return "host_key";
  if (value.includes("timeout") || value.includes("timed out")) return "timeout";
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("disconnect") || value.includes("connection closed")) return "disconnected";
  if (value.includes("stale") || value.includes("binding")) return "stale_binding";
  if (value.includes("permission") || value.includes("denied")) return "permission";
  if (value.includes("conflict") || value.includes("changed")) return "conflict";
  if (value.includes("unsupported")) return "unsupported";
  if (value.includes("connect") || value.includes("dns") || value.includes("transport")) return "connect";
  if (value.includes("io") || value.includes("disk") || value.includes("file")) return "io";
  return "unknown";
}
