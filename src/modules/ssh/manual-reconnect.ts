import { t } from "@/modules/i18n";
import { captureSshReconnectForwards } from "@/modules/ssh/auto-reconnect";
import { postConnectPendingInput } from "@/modules/ssh/post-connect";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { errorToast } from "@/ui/lib/error-toast";
import { reconnectPrefillFromSession, type RemoteInfo, type Session } from "@/ui/types";
import type { ForwardReconnectIntent } from "@/modules/terminal/lib/pty-bridge";

export function applySshInPlaceReconnect(
  sessionId: string,
  remote: RemoteInfo,
  forwards: ForwardReconnectIntent[] | undefined,
  extra?: { pendingSavedHost?: Session["pendingSavedHost"] },
): void {
  const store = useSessionsStore.getState();
  const session = store.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  const reconnectNonce = (session.reconnectNonce ?? 0) + 1;
  store.updateSession(sessionId, {
    remote,
    dir: session.dir,
    title: session.title,
    ptyId: undefined,
    transportGeneration: undefined,
    sshReconnectAttempt: undefined,
    sshReconnectLifecycle: (session.sshReconnectLifecycle ?? 0) + 1,
    sshReconnectNeedsCredential: false,
    sshReconnectForwards: forwards,
    pendingSavedHost: extra?.pendingSavedHost,
    runState: "idle",
    startedAt: undefined,
    completedAt: undefined,
    lastExitCode: undefined,
    terminalProgress: undefined,
    ...postConnectPendingInput(remote),
    reconnectNonce,
    terminalMountNonce: reconnectNonce,
  });
  store.handleConnectionEvent(sessionId, { type: "reconnectRequested" });
  store.setActive(sessionId);
}

export function sshRetryNeedsDialog(session: Session): boolean {
  const remote = session.remote;
  const failedAtPhase: string | undefined = session.connection?.failedAtPhase;
  return Boolean(remote && (
    session.sshReconnectNeedsCredential === true
    || remote.authMethod === "password"
    || remote.route?.jump.authMethod === "password"
    || failedAtPhase === "auth"
  ));
}

export async function retrySshSessionInPlace(
  session: Session,
): Promise<"reconnecting" | "dialog" | "failed"> {
  if (!session.remote) return "failed";
  if (sshRetryNeedsDialog(session)) {
    useUIStore.getState().openSshConnect(reconnectPrefillFromSession(session));
    return "dialog";
  }

  let forwards: ForwardReconnectIntent[];
  try {
    forwards = await captureSshReconnectForwards(session);
  } catch {
    useUIStore.getState().addToast(errorToast({
      title: t("ssh.forward.snapshotFailed"),
      next: t("ssh.forward.snapshotFailed_hint"),
    }));
    return "failed";
  }

  const latest = useSessionsStore.getState().sessions.find((candidate) => candidate.id === session.id);
  if (!latest?.remote) return "failed";
  applySshInPlaceReconnect(session.id, latest.remote, forwards, { pendingSavedHost: latest.pendingSavedHost });
  useUIStore.getState().showTerminal();
  return "reconnecting";
}
