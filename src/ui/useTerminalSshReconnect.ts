import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { notifySshOpenFailure, openSessionPty, reportSshOpenFailure, type PtyHandlers, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { takeSshReconnect, type PendingSshReconnect } from "@/modules/ssh/pending-credentials";
import { useSessionsStore } from "@/state/sessions";

type Reconnect = (request: PendingSshReconnect) => Promise<void>;

export function useTerminalSshReconnect(sessionId: string, reconnectNonce = 0, ready = false) {
  const reconnectRef = useRef<Reconnect | null>(null);
  const handledNonceRef = useRef(reconnectNonce);
  useEffect(() => {
    if (handledNonceRef.current === reconnectNonce || !reconnectRef.current) return;
    handledNonceRef.current = reconnectNonce;
    const request = takeSshReconnect(sessionId);
    if (request) void reconnectRef.current(request);
  }, [ready, reconnectNonce, sessionId]);
  return reconnectRef;
}

export function createTerminalSshReconnect(
  sessionIdRef: RefObject<string>,
  term: Terminal,
  ptyRef: RefObject<PtySession | null>,
  handlers: PtyHandlers,
  isDisposed: () => boolean,
  isPtyAlive: () => boolean,
  setPtyAlive: (alive: boolean) => void,
  setInputEnabled: (enabled: boolean) => void,
  setExitCode: Dispatch<SetStateAction<number | null>>,
  setOpenError: Dispatch<SetStateAction<string | null>>,
  setPtyReady: Dispatch<SetStateAction<boolean>>,
): Reconnect {
  let sequence = 0;
  let reconnecting = false;
  let publishedConnection: ReturnType<typeof useSessionsStore.getState>["sessions"][number]["connection"];
  return async ({ remote, credentials }) => {
    const attempt = sequence += 1;
    const sessionId = sessionIdRef.current;
    const previousSession = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
    const previousRemote = previousSession?.remote;
    const endpointChanged = !previousRemote
      || previousRemote.host !== remote.host
      || previousRemote.port !== remote.port
      || previousRemote.user !== remote.user;
    if (!reconnecting) publishedConnection = previousSession?.connection;
    reconnecting = true;
    useSessionsStore.getState().handleConnectionEvent(sessionId, {
      type: "openRequested",
      transport: "ssh",
      source: "user",
    });

    let replacement: PtySession;
    try {
      replacement = await openSessionPty(sessionId, term.cols, term.rows, handlers, {
        cwd: !endpointChanged && previousSession?.dir.startsWith("/") ? previousSession.dir : undefined,
        remote: { ...remote, ...credentials },
      });
    } catch (error) {
      if (isDisposed() || attempt !== sequence) return;
      reconnecting = false;
      if (isPtyAlive() && ptyRef.current) {
        useSessionsStore.getState().updateSession(sessionId, { connection: publishedConnection });
        notifySshOpenFailure(sessionId, remote, String(error));
      } else {
        setOpenError(String(error));
        reportSshOpenFailure(sessionId, remote, String(error));
      }
      return;
    }

    if (isDisposed() || attempt !== sequence) {
      replacement.close().catch(() => {});
      return;
    }
    reconnecting = false;
    const current = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
    const label = `${remote.user}@${remote.host}`;
    ptyRef.current = replacement;
    setPtyAlive(true);
    setInputEnabled(true);
    term.options.disableStdin = false;
    setExitCode(null);
    setOpenError(null);
    setPtyReady(true);
    useSessionsStore.getState().updateSession(sessionId, {
      remote,
      dir: endpointChanged ? label : current?.dir ?? label,
      title: endpointChanged && !current?.customTitle ? label : current?.title ?? label,
      ptyId: replacement.id,
      runState: "idle",
      startedAt: undefined,
      completedAt: undefined,
      lastExitCode: undefined,
      terminalProgress: undefined,
    });
    // The replaced PTY's exit can race with the invoke response and overwrite
    // the candidate's earlier ready event. Reassert the published connection.
    useSessionsStore.getState().handleConnectionEvent(sessionId, {
      type: "ready",
      transport: "ssh",
      source: "renderer",
    });
  };
}
