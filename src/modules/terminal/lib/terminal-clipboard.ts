import type { Terminal } from "@xterm/xterm";

export const MAX_OSC52_CLIPBOARD_BYTES = 256 * 1024;

export interface TerminalClipboardWrite {
  target: string;
  text: string;
}

export interface TerminalClipboardOptions {
  isWriteAllowed: () => boolean;
  writeText?: (text: string) => Promise<void>;
}

export function registerTerminalClipboardHandler(
  term: Terminal,
  options: TerminalClipboardOptions,
): () => void {
  const disposable = term.parser.registerOscHandler(52, (data) => handleTerminalClipboardOsc52(data, options));
  return () => disposable.dispose();
}

export function handleTerminalClipboardOsc52(data: string, options: TerminalClipboardOptions): boolean {
  const payload = parseOsc52Payload(data);
  if (!payload) return false;
  if (payload.data === "?") return true;
  if (!options.isWriteAllowed()) return true;

  const signal = parseTerminalClipboardWriteOsc52(data);
  if (!signal) return true;
  const writeText = options.writeText ?? ((text) => navigator.clipboard.writeText(text));
  writeText(signal.text).catch(() => {});
  return true;
}

export function parseTerminalClipboardWriteOsc52(
  data: string,
  maxBytes = MAX_OSC52_CLIPBOARD_BYTES,
): TerminalClipboardWrite | null {
  const payload = parseOsc52Payload(data);
  if (!payload || !payload.data || payload.data === "?") return null;
  const text = decodeBase64Text(payload.data, maxBytes);
  if (text === null) return null;
  return {
    target: payload.target || "c",
    text,
  };
}

function parseOsc52Payload(data: string): { target: string; data: string } | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  return {
    target: data.slice(0, separator),
    data: data.slice(separator + 1),
  };
}

function decodeBase64Text(value: string, maxBytes: number): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return null;
  }
  try {
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bin = atob(padded);
    if (bin.length > maxBytes) return null;
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
