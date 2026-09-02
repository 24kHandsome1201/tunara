export const KEYBINDING_ACTIONS = [
  "newTerminal",
  "terminalMenu",
  "copySelection",
  "safePaste",
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
  "togglePresentationMode",
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
  "focusLatestAttention",
] as const;

export type KeybindingAction = typeof KEYBINDING_ACTIONS[number];
export type KeybindingConfig = Record<KeybindingAction, string>;

export const TERMINAL_KEYBINDING_ACTIONS = [
  "terminalMenu",
  "copySelection",
  "safePaste",
] as const satisfies readonly KeybindingAction[];

export type TerminalKeybindingAction = typeof TERMINAL_KEYBINDING_ACTIONS[number];

export function isTerminalKeybindingAction(action: KeybindingAction): action is TerminalKeybindingAction {
  return (TERMINAL_KEYBINDING_ACTIONS as readonly KeybindingAction[]).includes(action);
}

export type KeybindingPlatform = "macos" | "windows" | "linux";

/** Previous default for jump-to-attention; rewritten to Mod+Enter on load. */
export const LEGACY_FOCUS_LATEST_ATTENTION = "Mod+Shift+U";

const COMMON_DEFAULT_KEYBINDINGS: KeybindingConfig = {
  newTerminal: "Mod+T",
  // Shift+F10 and the ContextMenu key remain fixed recovery paths. This is an
  // optional additional menu binding, so no extra chord is claimed by default.
  terminalMenu: "",
  copySelection: "Mod+C",
  safePaste: "Mod+V",
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
  togglePresentationMode: "Mod+Shift+P",
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
  focusLatestAttention: "Mod+Enter",
};

/** Defaults are explicit by platform so terminal-hostile bare Ctrl sequences are never introduced. */
export function defaultKeybindingsForPlatform(platform: KeybindingPlatform): KeybindingConfig {
  const defaults = { ...COMMON_DEFAULT_KEYBINDINGS };
  if (platform !== "macos") {
    defaults.copySelection = "Ctrl+Shift+C";
    defaults.safePaste = "Ctrl+Shift+V";
    defaults.closeSession = "Ctrl+Shift+W";
    defaults.splitHorizontal = "Alt+Shift+D";
    defaults.commandPalette = "Ctrl+Shift+K";
  }
  return defaults;
}

function runtimePlatform(): KeybindingPlatform {
  if (typeof navigator === "undefined") return "linux";
  const value = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("mac")) return "macos";
  return value.includes("win") ? "windows" : "linux";
}

export const DEFAULT_KEYBINDINGS: Readonly<KeybindingConfig> = defaultKeybindingsForPlatform(runtimePlatform());

export const KEYBINDING_CONFIG_KEYS: Record<KeybindingAction, string> = {
  newTerminal: "new_terminal",
  terminalMenu: "terminal_menu",
  copySelection: "copy_selection",
  safePaste: "safe_paste",
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
  togglePresentationMode: "toggle_presentation_mode",
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
  focusLatestAttention: "focus_latest_attention",
};

const CONFIG_KEY_TO_ACTION = Object.fromEntries(
  KEYBINDING_ACTIONS.map((action) => [KEYBINDING_CONFIG_KEYS[action], action]),
) as Record<string, KeybindingAction>;

function configActionForKey(key: string): KeybindingAction | undefined {
  if (Object.prototype.hasOwnProperty.call(CONFIG_KEY_TO_ACTION, key)) {
    return CONFIG_KEY_TO_ACTION[key];
  }
  return (KEYBINDING_ACTIONS as readonly string[]).includes(key)
    ? key as KeybindingAction
    : undefined;
}

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

export function normalizeKeybinding(def: string, platform: KeybindingPlatform = runtimePlatform()): string | null {
  const parsed = parseKeybinding(def);
  if (!parsed) return null;
  const modifiers = [
    parsed.mod && "Mod",
    parsed.ctrl && "Ctrl",
    parsed.meta && "Cmd",
    parsed.alt && "Alt",
    parsed.shift && "Shift",
  ].filter(Boolean);
  const key = parsed.key === " " ? "Space" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key[0].toUpperCase() + parsed.key.slice(1);
  // Persisted `Mod` remains portable; platform is used by conflict/risk signatures below.
  void platform;
  return [...modifiers, key].join("+");
}

function keybindingSignature(def: string, platform: KeybindingPlatform): string | null {
  const parsed = parseKeybinding(def);
  if (!parsed) return null;
  const ctrl = parsed.ctrl || (parsed.mod && platform !== "macos");
  const meta = parsed.meta || (parsed.mod && platform === "macos");
  return [ctrl && "Ctrl", meta && "Cmd", parsed.alt && "Alt", parsed.shift && "Shift", parsed.key]
    .filter(Boolean)
    .join("+");
}

export function captureKeybinding(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const key = normalizeKey(e.key);
  if (!key) return null;
  return normalizeKeybinding([
    e.metaKey && "Cmd", e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift",
    key === " " ? "Space" : key,
  ].filter(Boolean).join("+"));
}

export function findKeybindingConflict(config: KeybindingConfig, action: KeybindingAction, binding: string, platform: KeybindingPlatform = runtimePlatform()): KeybindingAction | null {
  const normalized = keybindingSignature(binding, platform);
  if (!normalized) return null;
  return KEYBINDING_ACTIONS.find((candidate) => candidate !== action && keybindingSignature(config[candidate], platform) === normalized) ?? null;
}

export function isFixedTerminalMenuKeybinding(binding: string, platform: KeybindingPlatform = runtimePlatform()): boolean {
  const signature = keybindingSignature(binding, platform);
  return signature === keybindingSignature("Shift+F10", platform)
    || signature === keybindingSignature("ContextMenu", platform);
}

export function isFixedTerminalMenuEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return (event.key === "F10" && event.shiftKey)
    || (event.key === "ContextMenu" && !event.shiftKey);
}

export type TerminalKeybindingRisk = { risky: boolean; reason?: "bare-control" | "shell-tui" };
export function analyzeTerminalKeybindingRisk(binding: string, platform: KeybindingPlatform = runtimePlatform()): TerminalKeybindingRisk {
  const parsed = parseKeybinding(binding);
  if (!parsed) return { risky: false };
  const effectiveCtrl = parsed.ctrl || (parsed.mod && platform !== "macos");
  const effectiveMeta = parsed.meta || (parsed.mod && platform === "macos");
  const bareCtrl = effectiveCtrl && !parsed.shift && !parsed.alt && !effectiveMeta;
  if (bareCtrl && (parsed.key.length === 1 || ["[", "]", "\\", "space"].includes(parsed.key))) return { risky: true, reason: "bare-control" };
  const common = new Set(["Ctrl+c", "Ctrl+d", "Ctrl+z", "Ctrl+l", "Ctrl+r", "Ctrl+a", "Ctrl+e", "Ctrl+k", "Ctrl+u", "Ctrl+w"]);
  return common.has(keybindingSignature(binding, platform) ?? "") ? { risky: true, reason: "shell-tui" } : { risky: false };
}

export function analyzeTerminalScopedKeybindingRisk(binding: string, platform: KeybindingPlatform = runtimePlatform()): TerminalKeybindingRisk {
  const existingRisk = analyzeTerminalKeybindingRisk(binding, platform);
  if (existingRisk.risky) return existingRisk;
  const parsed = parseKeybinding(binding);
  if (!parsed) return { risky: false };
  const effectiveCtrl = parsed.ctrl || (parsed.mod && platform !== "macos");
  const effectiveMeta = parsed.meta || (parsed.mod && platform === "macos");
  // Terminal-scoped handlers run inside xterm rather than at the app shell.
  // Require the platform's conventional host chord; plain, Alt-only, and
  // macOS Control chords can otherwise steal ordinary shell/TUI input.
  const conventionalHostChord = platform === "macos"
    ? effectiveMeta
    : effectiveCtrl && parsed.shift;
  return conventionalHostChord ? { risky: false } : { risky: true, reason: "shell-tui" };
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

function isLegacyFocusLatestAttention(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === LEGACY_FOCUS_LATEST_ATTENTION.toLowerCase();
}

export function sanitizeKeybindings(raw: unknown): KeybindingConfig {
  const next: KeybindingConfig = { ...DEFAULT_KEYBINDINGS };
  if (!raw || typeof raw !== "object") return next;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const action = configActionForKey(key);
    if (action && (isValidKeybinding(value) || (isTerminalKeybindingAction(action) && value === ""))) {
      next[action] = value;
    }
  }
  // Pre-redesign custom chord; Mod+Enter is the one remaining attention jump.
  if (isLegacyFocusLatestAttention(next.focusLatestAttention)) {
    next.focusLatestAttention = DEFAULT_KEYBINDINGS.focusLatestAttention;
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

  const expectsPlatformMod = parsed.mod || (isMac ? parsed.meta : parsed.ctrl);
  if (expectsPlatformMod !== modPressed) return false;
  if (explicitCtrl !== (parsed.mod && !isMac ? false : e.ctrlKey)) return false;
  if (explicitMeta !== (parsed.mod && isMac ? false : e.metaKey)) return false;
  if (parsed.alt !== e.altKey) return false;
  if (!plusFromEquals && parsed.shift !== e.shiftKey) return false;

  return parsed.key === actualKey || plusFromEquals;
}
