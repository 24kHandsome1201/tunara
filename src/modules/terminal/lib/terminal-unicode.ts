import type { Terminal } from "@xterm/xterm";

// Active Unicode version after loading the grapheme provider. Matches the
// version string UnicodeGraphemesAddon registers; kept explicit so a future
// addon revision cannot silently leave terminals on the Unicode 6 table.
export const TERMINAL_UNICODE_GRAPHEMES_VERSION = "15-graphemes";

/**
 * Switch a terminal to grapheme-cluster-aware cell widths.
 *
 * xterm's built-in width table predates emoji sequences, so ZWJ families,
 * regional-indicator flags, skin-tone modifiers and emoji presentation
 * selectors land in single-width cells and drag the cursor off column. The
 * addon registers Unicode 15 providers whose `charProperties` merges those
 * sequences into one wide cell, matching how shells and TUIs count them.
 *
 * The addon ships inside the lazy xterm chunk, so this resolves without a new
 * network fetch once the terminal is up. It must run before restored snapshot
 * and PTY output are written so every row agrees on cell widths; mixing width
 * tables mid-buffer would misalign exactly the columns this fixes.
 *
 * Width decisions stay consistent with the `text-spacing-trim: space-all`
 * rule on `.xterm`: the hidden DOM width cache measures grapheme spans the
 * same way the visible row renders them — CJK punctuation keeps its full cell,
 * nothing is contextually compressed.
 *
 * On failure (missing chunk, incompatible xterm) the built-in table stays
 * active and a no-op disposer is returned — degraded widths beat a dead pane.
 */
export async function registerTerminalUnicodeGraphemes(term: Terminal): Promise<() => void> {
  let UnicodeGraphemesAddon: typeof import("@xterm/addon-unicode-graphemes").UnicodeGraphemesAddon;
  try {
    ({ UnicodeGraphemesAddon } = await import("@xterm/addon-unicode-graphemes"));
  } catch (error) {
    console.debug("[terminal-unicode] grapheme addon unavailable, keeping built-in widths", error);
    return () => {};
  }
  const addon = new UnicodeGraphemesAddon();
  term.loadAddon(addon);
  // activate() already flips activeVersion; pin it so an addon revision that
  // stops doing so cannot regress widths silently.
  term.unicode.activeVersion = TERMINAL_UNICODE_GRAPHEMES_VERSION;
  return () => addon.dispose();
}
