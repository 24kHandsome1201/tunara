import type { PtyHandlers, PtyConnectionStatusPhase } from "./pty-bridge.ts";

type ScopedHandlers = {
  onData: (bytes: Uint8Array, acknowledge: () => void, generation: string) => void;
  onTransportLost?: (reason: string, generation: string) => void;
  onExit?: (code: number, generation: string) => void;
  onConnectionStatus?: (phase: PtyConnectionStatusPhase, generation: string) => void;
  onPendingConnectionStatus?: (phase: PtyConnectionStatusPhase) => void;
};

/** Admit events only from the one transport generation published by the view. */
export function createTerminalPtyGenerationGate(scoped: ScopedHandlers) {
  let active: string | null = null;
  let terminated: string | null = null;

  const accepts = (generation: string) => active === generation && terminated !== generation;
  const terminate = (generation: string, callback: () => void) => {
    if (!accepts(generation)) return;
    terminated = generation;
    callback();
  };

  const handlers: PtyHandlers = {
    onData(bytes, acknowledge, generation) {
      if (!accepts(generation)) {
        acknowledge();
        return;
      }
      scoped.onData(bytes, acknowledge, generation);
    },
    onTransportLost(reason, generation) {
      terminate(generation, () => scoped.onTransportLost?.(reason, generation));
    },
    onExit(code, generation) {
      terminate(generation, () => scoped.onExit?.(code, generation));
    },
    onConnectionStatus(phase, generation) {
      if (accepts(generation)) scoped.onConnectionStatus?.(phase, generation);
    },
    onPendingConnectionStatus(phase) {
      scoped.onPendingConnectionStatus?.(phase);
    },
  };

  return {
    handlers,
    publish(generation: string) {
      active = generation;
      terminated = null;
    },
  };
}
