export const KEYBINDING_ACTIONS = [
  "newTerminal",
  "newTerminalAlt",
  "closeSession",
  "openSettings",
  "toggleSidebar",
  "togglePanel",
  "splitHorizontal",
  "splitVertical",
  "focusSplitLeft",
  "focusSplitRight",
  "focusSplitUp",
  "focusSplitDown",
  "commandPalette",
  "quickSelect",
  "fontSizeUp",
  "fontSizeDown",
  "fontSizeReset",
  "selectTab1",
  "selectTab2",
  "selectTab3",
  "selectTab4",
  "selectTab5",
  "selectTab6",
  "selectTab7",
  "selectTab8",
  "selectLastTab",
] as const;

export type KeybindingAction = typeof KEYBINDING_ACTIONS[number];
export type KeybindingConfig = Record<KeybindingAction, string>;

export const DEFAULT_KEYBINDINGS: Readonly<KeybindingConfig> = {
  newTerminal: "Mod+T",
  newTerminalAlt: "Mod+N",
  closeSession: "Mod+W",
  openSettings: "Mod+,",
  toggleSidebar: "Mod+\\",
  togglePanel: "Mod+Shift+\\",
  splitHorizontal: "Mod+D",
  splitVertical: "Mod+Shift+D",
  focusSplitLeft: "Mod+[",
  focusSplitRight: "Mod+]",
  focusSplitUp: "Mod+Shift+[",
  focusSplitDown: "Mod+Shift+]",
  commandPalette: "Mod+K",
  quickSelect: "Mod+Shift+Space",
  fontSizeUp: "Mod+=",
  fontSizeDown: "Mod+-",
  fontSizeReset: "Mod+0",
  selectTab1: "Mod+1",
  selectTab2: "Mod+2",
  selectTab3: "Mod+3",
  selectTab4: "Mod+4",
  selectTab5: "Mod+5",
  selectTab6: "Mod+6",
  selectTab7: "Mod+7",
  selectTab8: "Mod+8",
  selectLastTab: "Mod+9",
};

export const KEYBINDING_CONFIG_KEYS: Record<KeybindingAction, string> = {
  newTerminal: "new_terminal",
  newTerminalAlt: "new_terminal_alt",
  closeSession: "close_session",
  openSettings: "open_settings",
  toggleSidebar: "toggle_sidebar",
  togglePanel: "toggle_panel",
  splitHorizontal: "split_horizontal",
  splitVertical: "split_vertical",
  focusSplitLeft: "focus_split_left",
  focusSplitRight: "focus_split_right",
  focusSplitUp: "focus_split_up",
  focusSplitDown: "focus_split_down",
  commandPalette: "command_palette",
  quickSelect: "quick_select",
  fontSizeUp: "font_size_up",
  fontSizeDown: "font_size_down",
  fontSizeReset: "font_size_reset",
  selectTab1: "select_tab_1",
  selectTab2: "select_tab_2",
  selectTab3: "select_tab_3",
  selectTab4: "select_tab_4",
  selectTab5: "select_tab_5",
  selectTab6: "select_tab_6",
  selectTab7: "select_tab_7",
  selectTab8: "select_tab_8",
  selectLastTab: "select_last_tab",
};

const CONFIG_KEY_TO_ACTION = Object.fromEntries(
  KEYBINDING_ACTIONS.map((action) => [KEYBINDING_CONFIG_KEYS[action], action]),
) as Record<string, KeybindingAction>;

type ParsedKeybinding = {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
};

function normalizeKey(key: string): string {
  const lowered = key.trim().toLowerCase();
  if (lowered === "space") return " ";
  if (lowered === "esc") return "escape";
  if (lowered === "plus") return "+";
  if (lowered === "comma") return ",";
  if (lowered === "backslash") return "\\";
  if (lowered === "{") return "[";
  if (lowered === "}") return "]";
  return lowered;
}

export function parseKeybinding(def: string): ParsedKeybinding | null {
  const plusKey = /\+\s*$/.test(def);
  const rawParts = def.split("+").map((p) => p.trim()).filter(Boolean);
  const parts = plusKey ? [...rawParts, "+"] : rawParts;
  if (parts.length === 0) return null;
  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return null;

  const parsed: ParsedKeybinding = { key, mod: false, shift: false, alt: false, ctrl: false, meta: false };
  for (const part of parts.slice(0, -1)) {
    const token = part.toLowerCase();
    if (token === "mod" || token === "cmdorctrl") parsed.mod = true;
    else if (token === "shift") parsed.shift = true;
    else if (token === "alt" || token === "option") parsed.alt = true;
    else if (token === "ctrl" || token === "control") parsed.ctrl = true;
    else if (token === "cmd" || token === "command" || token === "meta") parsed.meta = true;
    else return null;
  }
  return parsed;
}

export function isValidKeybinding(def: unknown): def is string {
  return typeof def === "string" && !!parseKeybinding(def);
}

export function sanitizeKeybindings(raw: unknown): KeybindingConfig {
  const next: KeybindingConfig = { ...DEFAULT_KEYBINDINGS };
  if (!raw || typeof raw !== "object") return next;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const action = CONFIG_KEY_TO_ACTION[key] ?? (
      (KEYBINDING_ACTIONS as readonly string[]).includes(key) ? key as KeybindingAction : undefined
    );
    if (action && isValidKeybinding(value)) next[action] = value;
  }
  return next;
}

export function keybindingsToConfigKeys(keybindings: KeybindingConfig): Record<string, string> {
  return Object.fromEntries(
    KEYBINDING_ACTIONS.map((action) => [KEYBINDING_CONFIG_KEYS[action], keybindings[action]]),
  );
}

export function hasPlatformModKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, isMac: boolean): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export function matchesKeybinding(e: KeyboardEvent, binding: string, isMac: boolean): boolean {
  const parsed = parseKeybinding(binding);
  if (!parsed) return false;
  const modPressed = hasPlatformModKey(e, isMac);
  const explicitCtrl = parsed.ctrl;
  const explicitMeta = parsed.meta;
  const actualKey = normalizeKey(e.key);
  const plusFromEquals = parsed.key === "=" && actualKey === "+";

  if (parsed.mod !== modPressed) return false;
  if (explicitCtrl !== (parsed.mod && !isMac ? false : e.ctrlKey)) return false;
  if (explicitMeta !== (parsed.mod && isMac ? false : e.metaKey)) return false;
  if (parsed.alt !== e.altKey) return false;
  if (!plusFromEquals && parsed.shift !== e.shiftKey) return false;

  return parsed.key === actualKey || plusFromEquals;
}
