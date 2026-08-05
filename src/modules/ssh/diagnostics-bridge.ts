import { Channel, invoke } from "@tauri-apps/api/core";
import type { DiagnosticReportV1, SshDiagnosticEventV1, SshDiagnosticRequestV1 } from "./diagnostics-schema";
import { appendDiagnostic, diagnosticsForSession, sanitizeDiagnosticEvent } from "./diagnostics-store";

export async function runSshDiagnostic(request: SshDiagnosticRequestV1, onEvent?: (event: SshDiagnosticEventV1) => void): Promise<void> {
  const channel = new Channel<SshDiagnosticEventV1>();
  channel.onmessage = event => {
    const safeEvent = sanitizeDiagnosticEvent(event);
    appendDiagnostic(request.sessionId, safeEvent);
    onEvent?.(safeEvent);
  };
  await invoke("ssh_diagnostic_run_v1", { request, channel });
}
export const cancelSshDiagnostic = (requestId: string): Promise<boolean> => invoke("ssh_diagnostic_cancel_v1", { requestId });
export function diagnosticReportV1(sessionId: string): DiagnosticReportV1 {
  const requestIds = new Map<string, string>();
  const events = diagnosticsForSession(sessionId).map((event) => {
    if (!requestIds.has(event.requestId)) requestIds.set(event.requestId, `REQUEST_${requestIds.size + 1}`);
    return {
      ...event,
      requestId: requestIds.get(event.requestId)!,
      diagnostic: {
        ...event.diagnostic,
        binding: event.diagnostic.binding ? {
          logicalSessionId: "SESSION_1",
          physicalPtyId: 0,
          transportGeneration: "GENERATION_1",
        } : undefined,
      },
    };
  });
  return {
    schemaVersion: 1,
    topology: { session: "SESSION_1", endpoint: "HOST_1", user: "USER_1", path: "PATH_1" },
    events,
  };
}
export const diagnosticReportText = (sessionId: string): string => JSON.stringify(diagnosticReportV1(sessionId), null, 2);
