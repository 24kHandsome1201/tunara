const ESC = 0x1b;
const BEL = 0x07;

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Return the first code-unit index after the escape sequence at `start`. */
function escapeSequenceEnd(value: string, start: number): number {
  const kind = value.charCodeAt(start + 1);
  if (!Number.isFinite(kind)) return value.length;

  // CSI: ESC [ parameters/intermediates final-byte.
  if (kind === 0x5b) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return value.length;
  }

  // OSC, DCS, SOS, PM and APC are string controls. OSC may end with BEL;
  // every string control may end with ST (ESC backslash).
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (kind === 0x5d && code === BEL) return index + 1;
      if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    }
    return value.length;
  }

  // Two-byte Fe escapes and the less common intermediate-byte form.
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) return index + 1;
    index += 1;
  }
  return value.length;
}

/**
 * Keep the newest terminal serialization without starting inside a UTF-16
 * surrogate pair or ANSI control sequence. The result never exceeds `limit`.
 */
export function trimTerminalSnapshotSerialized(value: string, limit: number): string {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (value.length <= boundedLimit) return value;
  if (boundedLimit === 0) return "";

  const rawStart = value.length - boundedLimit;
  let safeStart = isLowSurrogate(value.charCodeAt(rawStart)) ? rawStart + 1 : rawStart;

  // Parse only through the requested cut. If it lands inside a control
  // sequence, discard the remainder of that sequence before restoring text.
  for (let index = 0; index < safeStart;) {
    if (value.charCodeAt(index) !== ESC) {
      index += 1;
      continue;
    }
    const end = escapeSequenceEnd(value, index);
    if (end > safeStart) {
      safeStart = end;
      break;
    }
    index = end;
  }

  return value.slice(safeStart);
}
