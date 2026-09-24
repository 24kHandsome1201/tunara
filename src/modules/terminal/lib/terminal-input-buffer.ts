export interface TerminalInputBufferScanResult {
  buffer: string;
  submissions: string[];
  bracketedPasteActive: boolean;
}

const ESC = "\x1b";
const BEL = "\x07";
const STRING_TERMINATOR = "\\";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export interface TerminalInputScanState {
  /** Between an OSC 133 A (prompt start) and C (command start). */
  osc133Active: boolean;
  /** The last A marker carried `;input-fallback`. */
  inputFallbackRequested: boolean;
  /** Any OSC 133 marker has been seen from this terminal. */
  shellIntegrationSeen: boolean;
  /** A foreground TUI owns the keyboard (alternate screen / mouse tracking). */
  fullScreenApp: boolean;
}

/**
 * Native OSC 133 command markers are authoritative when available. Remote
 * Bash < 4.4 can emit prompt markers but has no non-invasive pre-exec hook, so
 * its A marker explicitly asks the frontend to keep scanning submitted input.
 * Once integration is live, keystrokes outside a prompt (after C, before the
 * next A) belong to the foreground program, not the shell. Full-screen TUIs
 * are never a shell prompt, with or without integration.
 */
export function shouldScanTerminalInput(state: TerminalInputScanState): boolean {
  if (state.fullScreenApp) return false;
  if (state.shellIntegrationSeen) return state.osc133Active && state.inputFallbackRequested;
  return true;
}

export interface TerminalInputModeSource {
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string };
}

/**
 * Alternate screen or mouse tracking means a TUI (vim, htop, HerdR...) is
 * reading keys. Application cursor mode is deliberately not used: zsh's ZLE
 * and readline with keypad enabled turn it on at an ordinary prompt.
 */
export function isTerminalInFullScreenApp(term: TerminalInputModeSource): boolean {
  return term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none";
}

function skipOscSequence(data: string, index: number): number {
  let i = index + 2;
  while (i < data.length) {
    if (data[i] === BEL) return i;
    if (data[i] === ESC && data[i + 1] === STRING_TERMINATOR) return i + 1;
    i += 1;
  }
  return data.length - 1;
}

function skipEscapeSequence(data: string, index: number): number {
  let i = index;
  while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i += 1;
  return i + 1 < data.length ? i + 1 : i;
}

export function scanTerminalInputBuffer(
  buffer: string,
  data: string,
  bracketedPasteActive = false,
): TerminalInputBufferScanResult {
  let nextBuffer = buffer;
  const submissions: string[] = [];

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (data.startsWith(BRACKETED_PASTE_START, i)) {
      bracketedPasteActive = true;
      i += BRACKETED_PASTE_START.length - 1;
    } else if (data.startsWith(BRACKETED_PASTE_END, i)) {
      bracketedPasteActive = false;
      i += BRACKETED_PASTE_END.length - 1;
    } else if (bracketedPasteActive && (ch === "\r" || ch === "\n")) {
      if (!(ch === "\n" && data[i - 1] === "\r")) nextBuffer += "\n";
    } else if (ch === ESC) {
      i = data[i + 1] === "]"
        ? skipOscSequence(data, i)
        : skipEscapeSequence(data, i);
    } else if (ch === "\r" || ch === "\n") {
      submissions.push(nextBuffer);
      nextBuffer = "";
    } else if (ch === "\x7f" || ch === "\b") {
      nextBuffer = nextBuffer.slice(0, -1);
    } else if (ch === "\x03" || ch === "\x15") {
      nextBuffer = "";
    } else if (ch >= " " && ch !== "\x7f") {
      nextBuffer += ch;
    }
  }

  return { buffer: nextBuffer, submissions, bracketedPasteActive };
}
