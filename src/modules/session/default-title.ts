import { t, translationsOf } from "../i18n/core.ts";

interface TitledSession {
  title: string;
  customTitle?: string;
  defaultTitleIndex?: number;
}

export function isDefaultTitleIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1_000_000;
}

/** Localized "Terminal N" label. Rendered at display time so it follows the UI language. */
export function defaultSessionTitle(index?: number): string {
  const base = t("session.default_title");
  return isDefaultTitleIndex(index) ? `${base} ${index}` : base;
}

/**
 * Recognizes a default title that older builds stored as a localized string
 * ("终端 2" / "Terminal 2", or the bare prefix) in any shipped locale.
 * Returns the number, 0 for the bare prefix, or null for a real title.
 */
export function parseDefaultSessionTitle(title: string | undefined): number | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  for (const base of translationsOf("session.default_title")) {
    if (trimmed === base) return 0;
    if (!trimmed.startsWith(`${base} `)) continue;
    const suffix = trimmed.slice(base.length + 1);
    if (/^[1-9]\d{0,5}$/.test(suffix)) return Number(suffix);
  }
  return null;
}

/** Custom title first, then the localized numbered default, then the stored title. */
export function sessionDisplayTitle(session: TitledSession): string {
  if (session.customTitle) return session.customTitle;
  if (isDefaultTitleIndex(session.defaultTitleIndex)) return defaultSessionTitle(session.defaultTitleIndex);
  return session.title;
}
