/**
 * addon-webgl 0.19 shares one TextureAtlas across every terminal whose render
 * config matches (font, theme, DPR). Page merges then leave sibling panes
 * drawing stale glyph UVs — the multi-split Codex/Grok garble that a resize
 * "fixes" (xterm.js #6038 / #6014). Stable xterm 6.1 with the upstream fix
 * has not shipped, so each session appends a unique, unused CSS font family.
 * Browsers skip unknown families, so glyphs stay on JetBrains Mono; the string
 * is only an atlas cache key.
 */
const ATLAS_FAMILY_PREFIX = "tunara-atlas-";

export function atlasIsolationFontToken(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const token = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return token || undefined;
}

export function withAtlasIsolationFontFamily(fontFamily: string, sessionId?: string): string {
  const token = atlasIsolationFontToken(sessionId);
  if (!token) return fontFamily;
  return `${fontFamily}, "${ATLAS_FAMILY_PREFIX}${token}"`;
}
