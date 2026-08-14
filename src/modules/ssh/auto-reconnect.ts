import { t } from "@/modules/i18n";
import { recordSshLifecycleDiagnostic } from "@/modules/ssh/diagnostics-store";
import { canRetrySshReconnect, sshReconnectDelayMs } from "@/modules/ssh/reconnect-policy";
import {
  rebuildReconnectForwards,
  snapshotReconnectForwards,
  sshOpenDiagnostic,
  type ForwardReconnectIntent,
  type SessionBindingV1,
} from "@/modules/terminal/lib/pty-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";
import { recordLocalUsageEvent } from "@/modules/usage-log/local-usage-log";

type RegisterCleanup = (cleanup: () => void) => void;

function intentKey(intent: ForwardReconnectIntent): string {
  return intent.kind === "local"
    ? `local\0${intent.bindHost}\0${intent.requestedLocalPort}\0${intent.targetHost}\0${intent.targetPort}`
    : `dynamic\0${intent.bindHost}\0${intent.requestedLocalPort}`;
}

function mergeForwardIntents(
  previous: ForwardReconnectIntent[],
  snapshot: ForwardReconnectIntent[],
): ForwardReconnectIntent[] {
  const unmatched = [...previous];
  for (const intent of snapshot) {
    const index = unmatched.findIndex((candidate) => intentKey(candidate) === intentKey(intent));
    if (index >= 0) unmatched.splice(index, 1);
  }
  return [...snapshot, ...unmatched];
}

/** Captures recreate-enabled forwarding intent while the old binding is still
 * authoritative. The backend handoff also releases its old listeners. */
export async function captureSshReconnectForwards(session: Session): Promise<ForwardReconnectIntent[]> {
  const previous = session.sshReconnectForwards ?? [];
  if (session.sshReconnectForwards !== undefined) return previous;
  if (session.ptyId === undefined || !session.transportGeneration) return previous;
  const binding = {
    logicalSessionId: session.id,
    physicalPtyId: session.ptyId,
    transportGeneration: session.transportGeneration,
  };
  return mergeForwardIntents(previous, await snapshotReconnectForwards(binding));
}

function scheduleReconnect(
  sessionId: string,
  attempt: number,
  lifecycle: number,
  forwards: ForwardReconnectIntent[],
  registerCleanup: RegisterCleanup,
): void {
  const store = useSessionsStore.getState();
  const current = store.sessions.find((candidate) => candidate.id === sessionId);
  if (!current?.remote?.autoReconnect || current.sshReconnectLifecycle !== lifecycle) return;
  store.updateSession(sessionId, { sshReconnectAttempt: attempt, sshReconnectForwards: forwards });
  store.handleConnectionEvent(sessionId, { type: "reconnectScheduled" });
  recordSshLifecycleDiagnostic(sessionId, "reconnect", "skipped", "transportClosed");
  const timer = window.setTimeout(() => {
    const latestStore = useSessionsStore.getState();
    const latest = latestStore.sessions.find((candidate) => candidate.id === sessionId);
    if (!latest?.remote?.autoReconnect
      || latest.sshReconnectAttempt !== attempt
      || latest.sshReconnectLifecycle !== lifecycle) return;
    const nonce = (latest.reconnectNonce ?? 0) + 1;
    latestStore.updateSession(sessionId, {
      ptyId: undefined,
      transportGeneration: undefined,
      reconnectNonce: nonce,
      terminalMountNonce: nonce,
      runState: "idle",
      startedAt: undefined,
      completedAt: undefined,
      lastExitCode: undefined,
      terminalProgress: undefined,
      unread: undefined,
      pendingInput: undefined,
      pendingInputSubmit: undefined,
    });
  }, sshReconnectDelayMs(attempt));
  registerCleanup(() => window.clearTimeout(timer));
}

export async function beginSshAutoReconnect(
  sessionId: string,
  binding: SessionBindingV1 | undefined,
  registerCleanup: RegisterCleanup,
): Promise<void> {
  let cancelled = false;
  registerCleanup(() => { cancelled = true; });
  const store = useSessionsStore.getState();
  const current = store.sessions.find((candidate) => candidate.id === sessionId);
  if (!current?.remote) return;
  const lifecycle = (current.sshReconnectLifecycle ?? 0) + 1;
  store.updateSession(sessionId, { sshReconnectLifecycle: lifecycle });
  let forwards: ForwardReconnectIntent[];
  try {
    forwards = binding
      ? await captureSshReconnectForwards(current)
      : current.sshReconnectForwards ?? [];
  } catch {
    if (cancelled) return;
    const latest = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    if (!latest?.remote || latest.sshReconnectLifecycle !== lifecycle) return;
    useSessionsStore.getState().handleConnectionEvent(sessionId, { type: "needsUserAction", reason: "pty" });
    recordLocalUsageEvent({ event: "ssh.reconnect.failed", sessionId, success: false, outcome: "failed", errorCategory: "internal" });
    useUIStore.getState().addToast({ sessionId, title: t("ssh.forward.snapshotFailed"), subtitle: "", variant: "error" });
    return;
  }
  if (cancelled) return;
  const latest = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  if (!latest?.remote || latest.sshReconnectLifecycle !== lifecycle) return;
  useSessionsStore.getState().updateSession(sessionId, { sshReconnectForwards: forwards });
  if (!latest.remote.autoReconnect) {
    useSessionsStore.getState().handleConnectionEvent(sessionId, { type: "needsUserAction", reason: "pty" });
    return;
  }
  if (latest.sshReconnectNeedsCredential) {
    useSessionsStore.getState().handleConnectionEvent(sessionId, { type: "needsUserAction", reason: "auth" });
    recordLocalUsageEvent({ event: "ssh.reconnect.failed", sessionId, success: false, outcome: "needs_user_action", errorCategory: "auth" });
    return;
  }
  scheduleReconnect(sessionId, 1, lifecycle, forwards, registerCleanup);
}

export function handleSshTransportLost(
  sessionId: string,
  generation: string,
  registerCleanup: RegisterCleanup,
): void {
  const current = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  const binding: SessionBindingV1 | undefined = current?.ptyId !== undefined
    && current.transportGeneration === generation
    ? { logicalSessionId: sessionId, physicalPtyId: current.ptyId, transportGeneration: generation }
    : undefined;
  useSessionsStore.getState().handleConnectionEvent(sessionId, { type: "transportLost" });
  recordSshLifecycleDiagnostic(sessionId, "reconnect", "failed", "transportClosed", binding);
  void beginSshAutoReconnect(sessionId, binding, registerCleanup);
}

export function markSshOneShotCredentialConsumed(
  sessionId: string,
  credentials: { password?: string; keyPassphrase?: string; jumpPassword?: string; jumpKeyPassphrase?: string } | undefined,
): void {
  if (credentials?.password || credentials?.keyPassphrase || credentials?.jumpPassword || credentials?.jumpKeyPassphrase) {
    useSessionsStore.getState().updateSession(sessionId, { sshReconnectNeedsCredential: true });
  }
}

/** Returns true when the retry lifecycle has fully consumed this open failure. */
export function handleSshReconnectFailure(
  sessionId: string,
  error: unknown,
  registerCleanup: RegisterCleanup,
): boolean {
  const current = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  const attempt = current?.sshReconnectAttempt;
  const lifecycle = current?.sshReconnectLifecycle;
  if (!current?.remote?.autoReconnect || attempt === undefined || lifecycle === undefined) return false;
  const diagnostic = sshOpenDiagnostic(error);
  if (diagnostic?.code === "hostKeyRejected" || diagnostic?.code === "authenticationFailed") {
    useSessionsStore.getState().handleConnectionEvent(sessionId, {
      type: "needsUserAction",
      reason: diagnostic.code === "hostKeyRejected" ? "hostKey" : "auth",
    });
    recordSshLifecycleDiagnostic(sessionId, "reconnect", "failed", diagnostic.code);
    recordLocalUsageEvent({
      event: "ssh.reconnect.failed",
      sessionId,
      success: false,
      outcome: "needs_user_action",
      errorCategory: diagnostic.code === "hostKeyRejected" ? "host_key" : "auth",
    });
    return true;
  }
  if (!diagnostic?.retryable || !canRetrySshReconnect(attempt)) return false;
  scheduleReconnect(sessionId, attempt + 1, lifecycle, current.sshReconnectForwards ?? [], registerCleanup);
  return true;
}

export function completeSshAutoReconnect(sessionId: string, binding: SessionBindingV1): void {
  const store = useSessionsStore.getState();
  const current = store.sessions.find((candidate) => candidate.id === sessionId);
  if (current?.sshReconnectForwards === undefined) return;
  const lifecycle = current.sshReconnectLifecycle;
  const forwards = current.sshReconnectForwards ?? [];
  const bindingIsCurrent = () => {
    const latest = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return latest?.ptyId === binding.physicalPtyId
      && latest.transportGeneration === binding.transportGeneration
      && latest.sshReconnectLifecycle === lifecycle;
  };
  const finish = () => {
    if (!bindingIsCurrent()) return;
    useSessionsStore.getState().updateSession(sessionId, {
      sshReconnectAttempt: undefined,
      sshReconnectForwards: undefined,
    });
    recordSshLifecycleDiagnostic(sessionId, "reconnect", "passed", "ok", binding);
    recordLocalUsageEvent({ event: "ssh.reconnect.completed", sessionId, success: true, outcome: "completed" });
  };
  if (forwards.length > 0) {
    void rebuildReconnectForwards(binding, forwards).then((results) => {
      if (!bindingIsCurrent()) return;
      let staleBinding = false;
      for (const result of results) {
        if (result.failure === "staleBinding") {
          staleBinding = true;
          continue;
        }
        if (result.failure) {
          recordSshLifecycleDiagnostic(sessionId, "forward", "failed", "internal", binding);
          useUIStore.getState().addToast({
            sessionId,
            title: t("ssh.forward.rebuildFailed"),
            subtitle: result.requestedLocalPort === 0
              ? t("ssh.forward.ephemeralFailed")
              : t("ssh.forward.fixedPortFailed", { port: result.requestedLocalPort }),
            variant: "error",
          });
        } else if (result.requestedLocalPort === 0 && result.newActualLocalPort != null) {
          recordSshLifecycleDiagnostic(sessionId, "forward", "passed", "ok", binding);
          useUIStore.getState().addToast({
            sessionId,
            title: t("ssh.forward.ephemeralRecreated"),
            subtitle: t("ssh.forward.portChanged", {
              oldPort: result.oldActualLocalPort,
              newPort: result.newActualLocalPort,
            }),
            variant: "success",
          });
        }
      }
      // The loss event may arrive just after the backend rejects a start.
      // Preserve desired intents for the incoming lifecycle to merge.
      if (!staleBinding) finish();
    }).catch(() => {
      if (bindingIsCurrent()) {
        recordSshLifecycleDiagnostic(sessionId, "forward", "failed", "internal", binding);
      }
      finish();
    });
  } else {
    finish();
  }
}
