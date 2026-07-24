const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x5d;
const ST = 0x5c;
const UTF8_C1_LEAD = 0xc2;
const C1_OSC_TRAIL = 0x9d;
const C1_ST_TRAIL = 0x9c;
const SEMICOLON = 0x3b;
const CR = 0x0d;
const LF = 0x0a;

export const TERMINAL_OSC_MAX_BYTES = 4 * 1024;
export const TERMINAL_OSC_TIMEOUT_MS = 1_000;

type GuardState =
  | "normal"
  | "c1Prefix"
  | "escape"
  | "oscPrefix"
  | "oscTarget"
  | "oscTargetEscape"
  | "oscTargetC1"
  | "oscDiscard"
  | "oscDiscardEscape"
  | "oscDiscardC1"
  | "oscPassthrough"
  | "oscPassthroughEscape"
  | "oscPassthroughC1";

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * Holds product-owned OSC 0/2/7 until their terminator is present. xterm never
 * sees a partial title/cwd sequence, so a disconnected transport cannot leave
 * the next shell's visible output trapped inside the previous OSC payload.
 */
export function createTerminalOscGuard({
  maxBytes = TERMINAL_OSC_MAX_BYTES,
  timeoutMs = TERMINAL_OSC_TIMEOUT_MS,
  now = () => Date.now(),
}: {
  maxBytes?: number;
  timeoutMs?: number;
  now?: () => number;
} = {}) {
  let state: GuardState = "normal";
  let pending: number[] = [];
  let command = "";
  let startedAt = 0;

  const resetSequence = () => {
    state = "normal";
    pending = [];
    command = "";
    startedAt = 0;
  };

  const discardTarget = () => {
    pending = [];
    command = "";
    startedAt = 0;
    state = "oscDiscard";
  };

  const push = (input: Uint8Array): Uint8Array => {
    if ((state === "oscTarget" || state === "oscTargetEscape" || state === "oscTargetC1") && now() - startedAt > timeoutMs) {
      discardTarget();
    }

    const output: number[] = [];
    const emitPending = () => {
      output.push(...pending);
      pending = [];
    };

    for (const byte of input) {
      if (state === "normal") {
        if (byte === ESC) {
          // An orphan ST is harmless outside a string control; preserve it
          // rather than risking consumption of a later legitimate sequence.
          state = "escape";
          pending = [byte];
        } else if (byte === UTF8_C1_LEAD) {
          state = "c1Prefix";
          pending = [byte];
        } else {
          output.push(byte);
        }
        continue;
      }

      if (state === "c1Prefix") {
        pending.push(byte);
        if (byte === C1_OSC_TRAIL) {
          state = "oscPrefix";
          command = "";
          startedAt = now();
        } else {
          emitPending();
          resetSequence();
        }
        continue;
      }

      if (state === "escape") {
        pending.push(byte);
        if (byte === OSC) {
          state = "oscPrefix";
          command = "";
          startedAt = now();
        } else {
          emitPending();
          resetSequence();
        }
        continue;
      }

      if (state === "oscPrefix") {
        pending.push(byte);
        if (isDigit(byte) && command.length < 5) {
          command += String.fromCharCode(byte);
          continue;
        }
        if (byte === SEMICOLON && (command === "0" || command === "2" || command === "7")) {
          state = "oscTarget";
          continue;
        }
        emitPending();
        if (byte === BEL) {
          resetSequence();
        } else {
          state = byte === ESC
            ? "oscPassthroughEscape"
            : byte === UTF8_C1_LEAD
              ? "oscPassthroughC1"
              : "oscPassthrough";
        }
        continue;
      }

      if (state === "oscTarget") {
        if (byte === CR || byte === LF) {
          resetSequence();
          output.push(byte);
          continue;
        }
        pending.push(byte);
        if (byte === BEL) {
          emitPending();
          resetSequence();
        } else if (byte === ESC) {
          state = "oscTargetEscape";
        } else if (byte === UTF8_C1_LEAD) {
          state = "oscTargetC1";
        } else if (pending.length > maxBytes) {
          discardTarget();
        }
        continue;
      }

      if (state === "oscTargetC1") {
        pending.push(byte);
        if (byte === C1_ST_TRAIL) {
          emitPending();
          resetSequence();
        } else if (pending.length > maxBytes) {
          discardTarget();
        } else {
          state = "oscTarget";
        }
        continue;
      }

      if (state === "oscTargetEscape") {
        pending.push(byte);
        if (byte === ST) {
          emitPending();
          resetSequence();
        } else {
          discardTarget();
        }
        continue;
      }

      if (state === "oscDiscard") {
        if (byte === BEL || byte === CR || byte === LF) {
          resetSequence();
          if (byte === CR || byte === LF) output.push(byte);
        } else if (byte === ESC) {
          state = "oscDiscardEscape";
        } else if (byte === UTF8_C1_LEAD) {
          state = "oscDiscardC1";
        }
        continue;
      }

      if (state === "oscDiscardEscape") {
        if (byte === ST) resetSequence();
        else state = "oscDiscard";
        continue;
      }

      if (state === "oscDiscardC1") {
        if (byte === C1_ST_TRAIL) resetSequence();
        else state = "oscDiscard";
        continue;
      }

      output.push(byte);
      if (state === "oscPassthroughEscape") {
        state = byte === ST ? "normal" : "oscPassthrough";
      } else if (state === "oscPassthroughC1") {
        state = byte === C1_ST_TRAIL ? "normal" : "oscPassthrough";
      } else if (byte === BEL) {
        state = "normal";
      } else if (byte === ESC) {
        state = "oscPassthroughEscape";
      } else if (byte === UTF8_C1_LEAD) {
        state = "oscPassthroughC1";
      }
    }
    return Uint8Array.from(output);
  };

  return {
    push,
    reset() {
      resetSequence();
    },
  };
}
