import { isMac } from "./lib/platform";

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  meta: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  ctrl: "⌃",
};

const PC_SYMBOLS: Record<string, string> = {
  mod: "Ctrl",
  cmd: "Cmd",
  meta: "Meta",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  ctrl: "Ctrl",
};

// Named keys, matched case-insensitively. macOS uses the menu-bar glyphs it
// already uses for modifiers; other platforms use title-case names.
const MAC_KEYS: Record<string, string> = {
  enter: "↩",
  return: "↩",
  escape: "⎋",
  esc: "⎋",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const PC_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

function displayKey(key: string, mac: boolean): string {
  const named = (mac ? MAC_KEYS : PC_KEYS)[key] ?? PC_KEYS[key];
  if (named) return named;
  // Single characters and function keys read best upper-cased ("K", "F10").
  if (key.length === 1 || /^f\d{1,2}$/.test(key)) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

/**
 * Convert a shortcut definition to a display string for the given platform.
 * Input uses canonical names: "mod+T", "Mod+Shift+D", "Mod+Enter", "Mod++".
 * macOS: "⌘T", "⌘⇧D", "⌘↩". Windows/Linux: "Ctrl+T", "Ctrl+Shift+D", "Ctrl+Enter".
 */
export function formatShortcutFor(def: string, mac: boolean): string {
  const trimmed = def.trim();
  const plusKey = trimmed.endsWith("++") || trimmed === "+";
  const parts = (plusKey ? trimmed.slice(0, -1) : trimmed).toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = plusKey ? "+" : parts.pop() ?? "";
  const symbols = mac ? MAC_SYMBOLS : PC_SYMBOLS;
  const sep = mac ? "" : "+";

  const modifiers = parts.map((p) => symbols[p] ?? p).join(sep);
  const label = key ? displayKey(key, mac) : "";

  return modifiers ? `${modifiers}${sep}${label}` : label;
}

export function formatShortcut(def: string): string {
  return formatShortcutFor(def, isMac);
}
