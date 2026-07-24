import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { updateTerminalSnapshot } from "./terminal-snapshot.ts";
import { captureSafeTerminalHistory } from "./terminal-safe-history.ts";

export function createTerminalSnapshotScheduler({
  term,
  serializeAddon,
  sessionId,
  isActive,
  shouldCapture = () => true,
}: {
  term: Terminal;
  serializeAddon: SerializeAddon;
  sessionId: () => string;
  isActive: () => boolean;
  shouldCapture?: () => boolean;
}) {
  // Minimum gap between serializations. Active terminals also get a floor so a
  // chatty agent (frequent small bursts with >1s pauses) can't trigger a full
  // scrollback serialize on every pause. Inactive terminals serialize far less
  // often since they're not on screen.
  const ACTIVE_MIN_INTERVAL_MS = 5_000;
  const INACTIVE_MIN_INTERVAL_MS = 10_000;
  const DEBOUNCE_MS = 1_000;

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotAt = 0;

  const capture = () => {
    snapshotTimer = null;
    if (!shouldCapture()) return;
    lastSnapshotAt = Date.now();
    updateTerminalSnapshot(sessionId(), {
      serialized: serializeAddon.serialize(),
      safeHistory: captureSafeTerminalHistory(term),
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      cols: term.cols,
      rows: term.rows,
      capturedAt: lastSnapshotAt,
      truncated: false,
    });
  };

  const schedule = () => {
    // A capture is already pending — the latest output will be included when it
    // fires, so don't stack timers.
    if (snapshotTimer) return;
    const minInterval = isActive() ? ACTIVE_MIN_INTERVAL_MS : INACTIVE_MIN_INTERVAL_MS;
    const sinceLast = Date.now() - lastSnapshotAt;
    // Normally debounce so a burst of output collapses into one serialize; but
    // if we're still inside the min-interval window, delay until the window ends
    // instead of returning outright. That guarantees the final batch of output
    // is eventually captured (previously, output produced in the throttle
    // window right before unmount/quit could be lost from the restore snapshot).
    const delay = Math.max(DEBOUNCE_MS, minInterval - sinceLast);
    snapshotTimer = setTimeout(capture, delay);
  };

  const flush = () => {
    if (snapshotTimer) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    capture();
  };

  return {
    schedule,
    flush,
    dispose() {
      // If output was pending capture when this terminal is torn down (pane
      // close / app quit), flush it synchronously so the very last batch makes
      // it into the restore snapshot instead of being dropped with the timer.
      if (snapshotTimer) flush();
    },
  };
}
