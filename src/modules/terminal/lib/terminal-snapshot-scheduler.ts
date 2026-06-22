import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { updateTerminalSnapshot } from "./terminal-snapshot";

export function createTerminalSnapshotScheduler({
  term,
  serializeAddon,
  sessionId,
  isActive,
}: {
  term: Terminal;
  serializeAddon: SerializeAddon;
  sessionId: () => string;
  isActive: () => boolean;
}) {
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInactiveSnapshotAt = 0;

  const schedule = () => {
    const now = Date.now();
    if (!isActive() && now - lastInactiveSnapshotAt < 10_000) return;
    if (!isActive()) lastInactiveSnapshotAt = now;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      updateTerminalSnapshot(sessionId(), {
        serialized: serializeAddon.serialize(),
        viewportY: term.buffer.active.viewportY,
        baseY: term.buffer.active.baseY,
        cols: term.cols,
        rows: term.rows,
        capturedAt: Date.now(),
        truncated: false,
      });
    }, 1000);
  };

  return {
    schedule,
    dispose() {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = null;
    },
  };
}
