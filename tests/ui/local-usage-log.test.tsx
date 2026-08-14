import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test } from "vitest";
import {
  hydrateLocalUsageLoggingEnabled,
  localUsageAuthMethod,
  localUsageErrorCategory,
  localUsagePhase,
  recordLocalUsageEvent,
  setLocalUsageLoggingEnabled,
  type LocalUsageLogStatus,
} from "@/modules/usage-log/local-usage-log";

const status = (enabled: boolean): LocalUsageLogStatus => ({
  enabled,
  directory: "/private/tunara/usage",
  fileCount: enabled ? 1 : 0,
  totalBytes: enabled ? 320 : 0,
  retentionDays: 7,
  maxTotalBytes: 20 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
});

beforeEach(() => {
  hydrateLocalUsageLoggingEnabled(false);
});

test("usage events are off by default and enabling emits only a structured request", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "local_usage_log_set_enabled") return status(true);
    if (command === "local_usage_log_record") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });

  recordLocalUsageEvent({ event: "ssh.session.created", sessionId: "session-private" });
  expect(calls).toEqual([]);

  await setLocalUsageLoggingEnabled(true);
  recordLocalUsageEvent({
    event: "ssh.terminal.command_finished",
    sessionId: "session-private",
    correlationId: "command-private",
    durationMs: 42,
    success: true,
    outcome: "completed",
    attributes: { transport: "ssh", exit_status: "zero" },
  });

  expect(calls).toEqual([
    { command: "local_usage_log_set_enabled", args: { enabled: true } },
    {
      command: "local_usage_log_record",
      args: {
        request: {
          event: "ssh.terminal.command_finished",
          sessionId: "session-private",
          correlationId: "command-private",
          durationMs: 42,
          success: true,
          outcome: "completed",
          attributes: { transport: "ssh", exit_status: "zero" },
        },
      },
    },
  ]);
});

test("disabling stops renderer writes before the native disable round trip completes", async () => {
  hydrateLocalUsageLoggingEnabled(true);
  let resolveDisable: ((value: LocalUsageLogStatus) => void) | undefined;
  const records: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "local_usage_log_set_enabled") {
      return new Promise<LocalUsageLogStatus>((resolve) => { resolveDisable = resolve; });
    }
    if (command === "local_usage_log_record") {
      records.push(args);
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  const disabling = setLocalUsageLoggingEnabled(false);
  recordLocalUsageEvent({ event: "ssh.session.closed", sessionId: "session-private" });
  expect(records).toEqual([]);
  resolveDisable?.(status(false));
  await disabling;
  recordLocalUsageEvent({ event: "ssh.session.closed", sessionId: "session-private" });
  expect(records).toEqual([]);
});

test("a failed disable remains fail-closed in the renderer", async () => {
  hydrateLocalUsageLoggingEnabled(true);
  const records: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "local_usage_log_set_enabled") throw new Error("status readback failed");
    if (command === "local_usage_log_record") {
      records.push(args);
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  await expect(setLocalUsageLoggingEnabled(false)).rejects.toThrow("status readback failed");
  recordLocalUsageEvent({ event: "ssh.session.closed", sessionId: "session-private" });
  expect(records).toEqual([]);
});

test("classification helpers return bounded categories rather than raw values", () => {
  expect(localUsageAuthMethod("password")).toBe("password");
  expect(localUsageAuthMethod("custom-secret-provider")).toBe("unknown");
  expect(localUsagePhase("verifyingHostKey")).toBe("verifying_host_key");
  expect(localUsageErrorCategory(new Error("authentication failed for a private endpoint"))).toBe("auth");
  expect(localUsageErrorCategory(new Error("connection closed after disconnect"))).toBe("disconnected");
  expect(localUsageErrorCategory(new Error("opaque backend detail"))).toBe("unknown");
});
