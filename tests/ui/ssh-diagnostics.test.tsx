import { beforeEach, describe, expect, test } from "vitest";
import { diagnosticReportText } from "@/modules/ssh/diagnostics-bridge";
import {
  appendDiagnostic,
  clearDiagnostics,
  diagnosticsForSession,
  sanitizeDiagnosticEvent,
} from "@/modules/ssh/diagnostics-store";
import type { SshDiagnosticEventV1 } from "@/modules/ssh/diagnostics-schema";
import { safeSshFailure } from "@/modules/terminal/lib/pty-bridge";

function event(index: number, safeContext?: Record<string, string | number | boolean>): SshDiagnosticEventV1 {
  return {
    requestId: `request-${index}`,
    status: "failed",
    diagnostic: {
      schemaVersion: 1,
      stage: "auth",
      code: "authenticationFailed",
      severity: "error",
      retryable: false,
      hopRole: "direct",
      timestamp: index,
      safeContext,
    },
  };
}

describe("SSH diagnostics safety boundaries", () => {
  beforeEach(clearDiagnostics);

  test("secret canary cannot cross event, toast, or copied-report surfaces", () => {
    const canary = "CANARY-password-passphrase-known-host-comment";
    const unsafe = event(1, { rawError: canary, port: 22 }) as SshDiagnosticEventV1 & {
      rawError: string;
      diagnostic: SshDiagnosticEventV1["diagnostic"] & { rawError: string };
    };
    unsafe.rawError = canary;
    unsafe.diagnostic.rawError = canary;
    const callbackEvent = sanitizeDiagnosticEvent(unsafe);
    appendDiagnostic(canary, callbackEvent);

    const stored = JSON.stringify(diagnosticsForSession(canary));
    const toast = JSON.stringify(safeSshFailure(`authentication failed: ${canary}`));
    const report = diagnosticReportText(canary);

    expect(JSON.stringify(callbackEvent)).not.toContain(canary);
    expect(stored).not.toContain(canary);
    expect(stored).toContain('"port":22');
    expect(toast).not.toContain(canary);
    expect(report).not.toContain(canary);
    expect(report).toContain("SESSION_1");
    expect(report).toContain("HOST_1");
  });

  test("store enforces per-session and global bounds", () => {
    for (let index = 0; index < 120; index += 1) appendDiagnostic("large", event(index));
    expect(diagnosticsForSession("large")).toHaveLength(100);

    for (let session = 0; session < 6; session += 1) {
      for (let index = 0; index < 100; index += 1) {
        appendDiagnostic(`session-${session}`, event(index));
      }
    }
    const total = ["large", ...Array.from({ length: 6 }, (_, index) => `session-${index}`)]
      .reduce((count, id) => count + diagnosticsForSession(id).length, 0);
    expect(total).toBeLessThanOrEqual(500);
  });

  test("report pseudonymizes request and transport binding identifiers", () => {
    const bound = event(1);
    bound.requestId = "real-request-id";
    bound.diagnostic.binding = {
      logicalSessionId: "real-session-id",
      physicalPtyId: 42,
      transportGeneration: "real-generation",
    };
    appendDiagnostic("real-session-id", bound);

    const report = diagnosticReportText("real-session-id");
    expect(report).not.toContain("real-");
    expect(report).not.toContain("42");
    expect(report).toContain("REQUEST_1");
    expect(report).toContain("GENERATION_1");
  });
});
