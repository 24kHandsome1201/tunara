import { isMac } from "./lib/platform";

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
};

const PC_SYMBOLS: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
};

/**
 * Convert a shortcut definition to a platform-appropriate display string.
 * Input uses canonical names: "mod+T", "mod+shift+D", "mod+,".
 * On macOS outputs "⌘T", "⌘⇧D", "⌘,".
 * On Windows/Linux outputs "Ctrl+T", "Ctrl+Shift+D", "Ctrl+,".
 */
export function formatShortcut(def: string): string {
  const parts = def.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const symbols = isMac ? MAC_SYMBOLS : PC_SYMBOLS;
  const sep = isMac ? "" : "+";

  const modifiers = parts.map((p) => symbols[p] ?? p).join(sep);
  const displayKey = key.toUpperCase();

  return modifiers ? `${modifiers}${sep}${displayKey}` : displayKey;
}
