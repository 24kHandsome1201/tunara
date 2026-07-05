function parseHexColor(hex: string): [number, number, number] {
  const normalized = hex.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    throw new Error(`Expected #rrggbb hex color, got ${hex}`);
  }
  const n = parseInt(normalized.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function channelLuminance(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHexColor(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.x contrast ratio between two #rrggbb colors (1–21). */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const MIN_SHELL_TINT_CONTRAST = 4.5;

/** Ensure every shell tint preset meets WCAG AA for primary text on base surface. */
export function assertShellTintContrast(
  shellTints: Record<string, Record<string, string>>,
  minRatio = MIN_SHELL_TINT_CONTRAST,
): void {
  for (const [preset, vars] of Object.entries(shellTints)) {
    const fg = vars["--c-text-primary"];
    const bg = vars["--c-bg-1"];
    if (!fg || !bg) {
      throw new Error(`Shell tint "${preset}" is missing --c-text-primary or --c-bg-1`);
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < minRatio) {
      throw new Error(
        `Shell tint "${preset}" contrast ${ratio.toFixed(2)}:1 is below ${minRatio}:1 (${fg} on ${bg})`,
      );
    }
  }
}