export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';
export const TERMINAL_FONT_LOAD_TIMEOUT_MS = 200;

type FontLoader = (fontSpec: string) => Promise<unknown>;
export type TerminalFontLoadResult = "loaded" | "timeout" | "unsupported" | "error";

function quoteSingleFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return '"JetBrains Mono"';
  if (trimmed.includes(",") || trimmed.startsWith("\"") || trimmed.startsWith("'")) return trimmed;
  if (/^(monospace|serif|sans-serif|cursive|fantasy|system-ui)$/i.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, "\\\"")}"`;
}

export function buildTerminalFontFamily(fontFamily: string, nerdFontFallback: boolean): string {
  const base = quoteSingleFamily(fontFamily);
  const fallback = nerdFontFallback
    ? '"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", SFMono-Regular, Menlo, monospace'
    : "SFMono-Regular, Menlo, monospace";
  return `${base}, ${fallback}`;
}

function browserFontLoader(): FontLoader | undefined {
  if (typeof document === "undefined") return undefined;
  return document.fonts?.load.bind(document.fonts);
}

export async function waitForTerminalFontReady({
  fontSize,
  fontFamily,
  nerdFontFallback,
  timeoutMs = TERMINAL_FONT_LOAD_TIMEOUT_MS,
  load = browserFontLoader(),
}: {
  fontSize: number;
  fontFamily: string;
  nerdFontFallback: boolean;
  timeoutMs?: number;
  load?: FontLoader;
}): Promise<TerminalFontLoadResult> {
  if (!load) return "unsupported";

  const fontSpec = `${fontSize}px ${buildTerminalFontFamily(fontFamily, nerdFontFallback)}`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<TerminalFontLoadResult>([
      load(fontSpec).then(() => "loaded", () => "error"),
      new Promise<TerminalFontLoadResult>((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
