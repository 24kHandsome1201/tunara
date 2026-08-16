/* 终端画布的字族回退与界面 --font-mono 保持一致：JetBrains Mono 内置，
   其后按平台补系统级等宽字体，末尾用 Noto Sans Mono CJK SC 兜住 CJK，
   避免中文字符落进非等宽字体破坏列对齐。 */
export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace';
export const TERMINAL_FONT_LOAD_TIMEOUT_MS = 200;

type FontLoader = (fontSpec: string) => Promise<unknown>;
export type TerminalFontLoadResult = "loaded" | "timeout" | "unsupported" | "error";

function quoteSingleFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return '"JetBrains Mono"';
  if (trimmed.includes(",") || trimmed.startsWith("\"") || trimmed.startsWith("'")) return trimmed;
  if (/^(monospace|serif|sans-serif|cursive|fantasy|system-ui)$/i.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function buildTerminalFontFamily(fontFamily: string, nerdFontFallback: boolean): string {
  const base = quoteSingleFamily(fontFamily);
  const platformFallback =
    'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace';
  const fallback = nerdFontFallback
    ? `"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", ${platformFallback}`
    : platformFallback;
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
