import type { IMarker, Terminal } from "@xterm/xterm";
import { sanitizeTerminalTitle } from "./terminal-utils.ts";

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export function registerTitleHandlers(
  term: Terminal,
  onTitle: (title: string) => void,
): () => void {
  const handle = (data: string) => {
    const title = sanitizeTerminalTitle(data);
    if (title) onTitle(title);
    // Consume OSC 0/2 so xterm's unbounded built-in title callback cannot
    // bypass product sanitization.
    return true;
  };
  const iconAndTitle = term.parser.registerOscHandler(0, handle);
  const title = term.parser.registerOscHandler(2, handle);
  return () => {
    iconAndTitle.dispose();
    title.dispose();
  };
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(term: Terminal): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    if (data.startsWith("A")) {
      marker?.dispose();
      marker = term.registerMarker(0);
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

export function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (!m) return null;
  if (!isLocalOscHost(m[1])) return null;
  try {
    return decodeURIComponent(m[2]);
  } catch {
    return m[2];
  }
}

function isLocalOscHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return true;
  }
  const browserHost = globalThis.location?.hostname?.toLowerCase();
  return !!browserHost && normalized === browserHost;
}
