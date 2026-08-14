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
const MIN_CONTROL_CONTRAST = 3;
const TEXT_KEYS = [
  "--c-text-primary",
  "--c-text-2",
  "--c-text-3",
  "--c-text-4",
  "--c-text-5",
  "--c-text-6",
  "--c-text-7",
] as const;
const SURFACE_KEYS = [
  "--c-bg-white",
  "--c-bg-1",
  "--c-bg-2",
  "--c-bg-3",
  "--c-bg-hover",
] as const;
const CONTROL_BORDER_KEYS = ["--c-border-2", "--c-control-border"] as const;

/** Ensure normal text and control boundaries remain perceivable on every shell surface. */
export function assertShellTintContrast(
  shellTints: Record<string, Record<string, string>>,
  minRatio = MIN_SHELL_TINT_CONTRAST,
): void {
  for (const [preset, vars] of Object.entries(shellTints)) {
    for (const key of [...TEXT_KEYS, ...SURFACE_KEYS, ...CONTROL_BORDER_KEYS] as const) {
      if (!vars[key]) throw new Error(`Shell tint "${preset}" is missing ${key}`);
    }

    for (const textKey of TEXT_KEYS) {
      for (const surfaceKey of SURFACE_KEYS) {
        const fg = vars[textKey];
        const bg = vars[surfaceKey];
        const ratio = contrastRatio(fg, bg);
        if (ratio < minRatio) {
          throw new Error(
            `Shell tint "${preset}" ${textKey} contrast ${ratio.toFixed(2)}:1 is below ${minRatio}:1 on ${surfaceKey} (${fg} on ${bg})`,
          );
        }
      }
    }

    for (const borderKey of CONTROL_BORDER_KEYS) {
      for (const surfaceKey of SURFACE_KEYS) {
        const border = vars[borderKey];
        const bg = vars[surfaceKey];
        const ratio = contrastRatio(border, bg);
        if (ratio < MIN_CONTROL_CONTRAST) {
          throw new Error(
            `Shell tint "${preset}" ${borderKey} contrast ${ratio.toFixed(2)}:1 is below ${MIN_CONTROL_CONTRAST}:1 on ${surfaceKey} (${border} on ${bg})`,
          );
        }
      }
    }
  }
}
