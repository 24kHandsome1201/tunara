export interface TerminalInputBufferScanResult {
  buffer: string;
  submissions: string[];
}

const ESC = "\x1b";
const BEL = "\x07";
const STRING_TERMINATOR = "\\";

/**
 * Native OSC 133 command markers are authoritative when available. Remote
 * Bash < 4.4 can emit prompt markers but has no non-invasive pre-exec hook, so
 * its A marker explicitly asks the frontend to keep scanning submitted input.
 */
export function shouldScanTerminalInput(
  osc133Active: boolean,
  inputFallbackRequested: boolean,
): boolean {
  return !osc133Active || inputFallbackRequested;
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

export function scanTerminalInputBuffer(buffer: string, data: string): TerminalInputBufferScanResult {
  let nextBuffer = buffer;
  const submissions: string[] = [];

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === ESC) {
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

  return { buffer: nextBuffer, submissions };
}
