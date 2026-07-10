export const TERMINAL_LAYOUT_FRAME_TIMEOUT_MS = 120;

type TimerHandle = ReturnType<typeof setTimeout>;

interface TerminalLayoutFrameOptions {
  timeoutMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => TimerHandle;
  cancelTimeout?: (handle: TimerHandle) => void;
}

export type TerminalLayoutFrameResult = "frame" | "timeout";

/**
 * Wait for one paint opportunity without trusting requestAnimationFrame to
 * fire while WKWebView is backgrounded during cold start or window restore.
 * The resize observer corrects the terminal again when the window is visible.
 */
export function waitForTerminalLayoutFrame({
  timeoutMs = TERMINAL_LAYOUT_FRAME_TIMEOUT_MS,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  cancelTimeout = (handle) => clearTimeout(handle),
}: TerminalLayoutFrameOptions = {}): Promise<TerminalLayoutFrameResult> {
  return new Promise((resolve) => {
    let settled = false;
    let frameId: number | null = null;
    const finish = (result: TerminalLayoutFrameResult) => {
      if (settled) return;
      settled = true;
      if (result === "frame") cancelTimeout(timer);
      else if (frameId !== null) cancelFrame(frameId);
      resolve(result);
    };

    const timer = scheduleTimeout(() => finish("timeout"), timeoutMs);
    frameId = requestFrame(() => finish("frame"));
  });
}
