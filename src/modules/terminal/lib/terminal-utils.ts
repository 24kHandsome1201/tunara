export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function cleanTerminalText(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanTerminalLines(text: string): string {
  return stripTerminalControlSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

const TITLE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const TRAILING_TITLE_DECORATION = /[-‐‑‒–—―─━═╌╍╴╶\s]{33,}$/u;
const TITLE_DECORATION_ONLY = /^[-‐‑‒–—―─━═╌╍╴╶\s]+$/u;
const MAX_TITLE_GRAPHEMES = 128;
const MAX_TITLE_BYTES = 512;

function titleGraphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: "grapheme" },
    ) => { segment: (input: string) => Iterable<{ segment: string }> };
  }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

export function sanitizeTerminalTitle(title: string): string | null {
  const normalized = title
    .normalize("NFC")
    .replace(TITLE_UNSAFE, "")
    .replace(/\s+/g, " ")
    .replace(TRAILING_TITLE_DECORATION, "")
    .trim();
  if (!normalized) return null;

  const graphemes = titleGraphemes(normalized);
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let bytes = 0;
  let truncated = graphemes.length > MAX_TITLE_GRAPHEMES;
  for (const grapheme of graphemes.slice(0, MAX_TITLE_GRAPHEMES)) {
    const next = encoder.encode(grapheme).byteLength;
    if (bytes + next > MAX_TITLE_BYTES) {
      truncated = true;
      break;
    }
    kept.push(grapheme);
    bytes += next;
  }
  if (truncated && bytes + encoder.encode("…").byteLength <= MAX_TITLE_BYTES) kept.push("…");
  const result = kept.join("").trim();
  if (!result || TITLE_DECORATION_ONLY.test(result)) return null;
  return result;
}
