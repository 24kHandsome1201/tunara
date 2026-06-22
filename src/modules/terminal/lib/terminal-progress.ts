import type { Terminal } from "@xterm/xterm";
import type { TerminalProgress } from "../../../ui/types.ts";

export interface TerminalProgressSignal {
  progress: TerminalProgress | null;
}

export function parseTerminalProgressOsc(
  data: string,
  now = Date.now(),
): TerminalProgressSignal | null {
  const parts = data.split(";");
  if (parts[0] !== "4") return null;

  const state = Number(parts[1]);
  if (!Number.isInteger(state) || state < 0 || state > 4) return null;
  if (state === 0) return { progress: null };

  const value = parseProgressValue(parts[2]);
  if (state === 1 && value === null) return null;

  if (state === 3) {
    return { progress: { state: "indeterminate", updatedAt: now } };
  }

  return {
    progress: {
      state: state === 2 ? "error" : state === 4 ? "warning" : "normal",
      ...(value !== null ? { value } : {}),
      updatedAt: now,
    },
  };
}

export function registerTerminalProgressHandler(
  term: Terminal,
  onProgress: (progress: TerminalProgress | undefined) => void,
): () => void {
  const disposable = term.parser.registerOscHandler(9, (data) => {
    const signal = parseTerminalProgressOsc(data);
    if (!signal) return false;
    onProgress(signal.progress ?? undefined);
    return true;
  });
  return () => disposable.dispose();
}

function parseProgressValue(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}
