import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { TERMINAL_THEME_NAMES, type OverlayType, type ThemeType, type TerminalThemeName } from "@/ui/types";
import { loadTunaraConfig, saveTunaraConfig, type RawAppearanceConfig, type RawTunaraConfig } from "@/modules/config/config-bridge";
import { DEFAULT_KEYBINDINGS, keybindingsToConfigKeys, sanitizeKeybindings, type KeybindingAction, type KeybindingConfig } from "@/modules/config/keybindings";
import { isLanguage, setLanguage as applyLanguage, type Language } from "@/modules/i18n";

export type CursorStyle = "bar" | "block" | "underline";

export type SplitMode = "single" | "horizontal" | "vertical";

export interface SplitState {
  mode: SplitMode;
  paneA: string | null;
  paneB: string | null;
  ratio: number;
}

export interface AppearanceSettings {
  theme: ThemeType;
  accent: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  fontSize: number;
  fontFamily: string;
  fontLigatures: boolean;
  nerdFontFallback: boolean;
  scrollback: number;
  sidebarWidth: number;
  panelWidth: number;
  terminalTheme: TerminalThemeName;
  externalEditor: ExternalEditor;
  bellNotification: boolean;
  terminalClipboardWrite: boolean;
  terminalInlineImages: boolean;
  keybindings: KeybindingConfig;
  language: Language;
}

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 22;
const MIN_SCROLLBACK = 1000;
const MAX_SCROLLBACK = 20000;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH_RATIO = 0.45;

export const DEFAULT_SETTINGS: Readonly<AppearanceSettings> = {
  theme: "light",
  accent: "#c2683c",
  cursorStyle: "bar",
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "JetBrains Mono",
  fontLigatures: false,
  nerdFontFallback: true,
  scrollback: 2000,
  sidebarWidth: 272,
  panelWidth: 320,
  terminalTheme: "default",
  externalEditor: "vscode",
  bellNotification: true,
  terminalClipboardWrite: false,
  terminalInlineImages: true,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  language: "system",
};

function isExternalEditor(v: unknown): v is ExternalEditor {
  return v === "vscode" || v === "cursor" || v === "zed" || v === "sublime";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function maxPanelWidth(): number {
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  return Math.max(MIN_PANEL_WIDTH, Math.floor(vw * MAX_PANEL_WIDTH_RATIO));
}

function isTheme(value: unknown): value is ThemeType {
  return value === "light" || value === "dark" || value === "system";
}

function isCursorStyle(value: unknown): value is CursorStyle {
  return value === "bar" || value === "block" || value === "underline";
}

function isTerminalTheme(value: unknown): value is TerminalThemeName {
  return typeof value === "string" && (TERMINAL_THEME_NAMES as readonly string[]).includes(value);
}

function sanitizeAccent(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value
    : DEFAULT_SETTINGS.accent;
}

function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.fontFamily;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 160 && !/[\r\n;]/.test(trimmed)
    ? trimmed
    : DEFAULT_SETTINGS.fontFamily;
}

function sanitizeRawAppearance(raw: Partial<RawAppearanceConfig> | undefined): AppearanceSettings {
  return {
    ...DEFAULT_SETTINGS,
    theme: isTheme(raw?.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    accent: sanitizeAccent(raw?.accent),
    cursorStyle: isCursorStyle(raw?.cursor_style) ? raw.cursor_style : DEFAULT_SETTINGS.cursorStyle,
    cursorBlink: typeof raw?.cursor_blink === "boolean" ? raw.cursor_blink : DEFAULT_SETTINGS.cursorBlink,
    fontSize: clampNumber(raw?.font_size, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS.fontSize),
    fontFamily: sanitizeFontFamily(raw?.font_family),
    fontLigatures: typeof raw?.font_ligatures === "boolean" ? raw.font_ligatures : DEFAULT_SETTINGS.fontLigatures,
    nerdFontFallback: typeof raw?.nerd_font_fallback === "boolean" ? raw.nerd_font_fallback : DEFAULT_SETTINGS.nerdFontFallback,
    scrollback: clampNumber(raw?.scrollback, MIN_SCROLLBACK, MAX_SCROLLBACK, DEFAULT_SETTINGS.scrollback),
    sidebarWidth: clampNumber(raw?.sidebar_width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SETTINGS.sidebarWidth),
    panelWidth: clampNumber(raw?.panel_width, MIN_PANEL_WIDTH, maxPanelWidth(), DEFAULT_SETTINGS.panelWidth),
    terminalTheme: isTerminalTheme(raw?.terminal_theme) ? raw.terminal_theme : DEFAULT_SETTINGS.terminalTheme,
    externalEditor: isExternalEditor(raw?.external_editor) ? raw.external_editor : DEFAULT_SETTINGS.externalEditor,
    bellNotification: typeof raw?.bell_notification === "boolean" ? raw.bell_notification : DEFAULT_SETTINGS.bellNotification,
    terminalClipboardWrite: typeof raw?.terminal_clipboard_write === "boolean" ? raw.terminal_clipboard_write : DEFAULT_SETTINGS.terminalClipboardWrite,
    terminalInlineImages: typeof raw?.terminal_inline_images === "boolean" ? raw.terminal_inline_images : DEFAULT_SETTINGS.terminalInlineImages,
    keybindings: { ...DEFAULT_KEYBINDINGS },
    language: isLanguage(raw?.language) ? raw.language : DEFAULT_SETTINGS.language,
  };
}

function sanitizeConfig(config: RawTunaraConfig | undefined): AppearanceSettings {
  const appearance = sanitizeRawAppearance(config?.appearance);
  return {
    ...appearance,
    keybindings: sanitizeKeybindings(config?.keybindings),
  };
}

function settingsToRawConfig(s: AppearanceSettings): RawTunaraConfig {
  return {
    appearance: {
      theme: s.theme,
      accent: s.accent,
      cursor_style: s.cursorStyle,
      cursor_blink: s.cursorBlink,
      font_size: s.fontSize,
      font_family: s.fontFamily,
      font_ligatures: s.fontLigatures,
      nerd_font_fallback: s.nerdFontFallback,
      scrollback: s.scrollback,
      sidebar_width: s.sidebarWidth,
      panel_width: s.panelWidth,
      terminal_theme: s.terminalTheme,
      external_editor: s.externalEditor,
      bell_notification: s.bellNotification,
      terminal_clipboard_write: s.terminalClipboardWrite,
      terminal_inline_images: s.terminalInlineImages,
      language: s.language,
    },
    keybindings: keybindingsToConfigKeys(s.keybindings),
  };
}

export type InspectorTab = "overview" | "changes" | "files" | "notes";

export type ExternalEditor = "vscode" | "cursor" | "zed" | "sublime";

export const EXTERNAL_EDITORS: ExternalEditor[] = ["vscode", "cursor", "zed", "sublime"];

export const EDITOR_LABELS: Record<ExternalEditor, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  sublime: "Sublime",
};

export interface Toast {
  id: string;
  sessionId: string;
  title: string;
  subtitle: string;
  variant: "success" | "error";
  agentCode?: string;
}

/** A pending SSH host-key confirmation (TOFU). The backend ssh_open call is
 * blocked until the user accepts/rejects the fingerprint. */
export interface HostKeyPrompt {
  promptId: string;
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
}

/** A workflow chosen from the palette whose template has {{params}} still to
 * fill. An app-level prompt collects the values, then runs it. */
export interface PendingWorkflow {
  workflowId: string;
  name: string;
  template: string;
  /** Directory to launch the resulting command in. */
  dir: string;
  /** Branch from the session that launched the workflow, for dynamic vars. */
  branch?: string;
}

interface UIState extends AppearanceSettings {
  ready: boolean;
  configLoaded: boolean;
  configPath: string;
  configError: string | null;
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  trafficLightWidth: number;
  viewportWidth: number;
  split: SplitState;
  inspectorTab: InspectorTab;
  toasts: Toast[];
  hostKeyPrompt: HostKeyPrompt | null;
  pendingWorkflow: PendingWorkflow | null;
  collapsedDirs: Record<string, true>;
  commandUsage: Record<string, number>;

  setSidebarVisible: (visible: boolean) => void;
  setPanelVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setOverlay: (o: OverlayType) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setTheme: (t: ThemeType) => void;
  setAccent: (c: string) => void;
  setCursorStyle: (c: CursorStyle) => void;
  setCursorBlink: (b: boolean) => void;
  setFontSize: (n: number) => void;
  setFontFamily: (name: string) => void;
  setFontLigatures: (enabled: boolean) => void;
  setNerdFontFallback: (enabled: boolean) => void;
  setScrollback: (n: number) => void;
  setTerminalTheme: (t: TerminalThemeName) => void;
  setSidebarWidth: (w: number) => void;
  setPanelWidth: (w: number) => void;
  setTrafficLightWidth: (w: number) => void;
  setViewportWidth: (w: number) => void;
  splitHorizontal: (paneASessionId: string, paneBSessionId: string) => void;
  splitVertical: (paneASessionId: string, paneBSessionId: string) => void;
  closeSplit: () => void;
  setSplitRatio: (ratio: number) => void;
  setSplitPaneB: (sessionId: string | null) => void;
  setSplitPaneA: (sessionId: string | null) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  setHostKeyPrompt: (prompt: HostKeyPrompt | null) => void;
  setPendingWorkflow: (workflow: PendingWorkflow | null) => void;
  toggleDirCollapsed: (dir: string) => void;
  recordCommandUse: (id: string) => void;
  setExternalEditor: (e: ExternalEditor) => void;
  setBellNotification: (b: boolean) => void;
  setTerminalClipboardWrite: (enabled: boolean) => void;
  setTerminalInlineImages: (enabled: boolean) => void;
  setKeybinding: (action: KeybindingAction, binding: string) => void;
  resetKeybindings: () => void;
  resetAppearance: () => void;
  setLanguage: (lang: Language) => void;
}

export const useUIStore = create<UIState>()(subscribeWithSelector((set) => {
  return {
    ready: false,
    configLoaded: false,
    configPath: "",
    configError: null,
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    trafficLightWidth: 0,
    viewportWidth: typeof window === "undefined" ? 1200 : window.innerWidth,
    split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
    inspectorTab: "overview" as InspectorTab,
    toasts: [],
    hostKeyPrompt: null,
    pendingWorkflow: null,
    collapsedDirs: {},
    // Hydrated from the workspace snapshot in useInit; starts empty.
    commandUsage: {},
    ...DEFAULT_SETTINGS,

    setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
    setPanelVisible: (panelVisible) => set({ panelVisible }),
    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    setOverlay: (overlay) => set({ overlay }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    setTheme: (theme) => set({ theme: isTheme(theme) ? theme : DEFAULT_SETTINGS.theme }),
    setAccent: (accent) => set({ accent: sanitizeAccent(accent) }),
    setCursorStyle: (cursorStyle) => set({ cursorStyle: isCursorStyle(cursorStyle) ? cursorStyle : DEFAULT_SETTINGS.cursorStyle }),
    setCursorBlink: (cursorBlink) => set({ cursorBlink: typeof cursorBlink === "boolean" ? cursorBlink : DEFAULT_SETTINGS.cursorBlink }),
    setFontSize: (fontSize) => set({ fontSize: clampNumber(fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS.fontSize) }),
    setFontFamily: (fontFamily) => set({ fontFamily: sanitizeFontFamily(fontFamily) }),
    setFontLigatures: (fontLigatures) => set({ fontLigatures: typeof fontLigatures === "boolean" ? fontLigatures : DEFAULT_SETTINGS.fontLigatures }),
    setNerdFontFallback: (nerdFontFallback) => set({ nerdFontFallback: typeof nerdFontFallback === "boolean" ? nerdFontFallback : DEFAULT_SETTINGS.nerdFontFallback }),
    setScrollback: (scrollback) => set({ scrollback: clampNumber(scrollback, MIN_SCROLLBACK, MAX_SCROLLBACK, DEFAULT_SETTINGS.scrollback) }),
    setTerminalTheme: (terminalTheme) => set({ terminalTheme: isTerminalTheme(terminalTheme) ? terminalTheme : DEFAULT_SETTINGS.terminalTheme }),
    setSidebarWidth: (sidebarWidth) => {
      set({ sidebarWidth: clampNumber(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SETTINGS.sidebarWidth) });
    },
    setPanelWidth: (panelWidth) => {
      set({ panelWidth: clampNumber(panelWidth, MIN_PANEL_WIDTH, maxPanelWidth(), DEFAULT_SETTINGS.panelWidth) });
    },
    setTrafficLightWidth: (trafficLightWidth) => set({ trafficLightWidth }),
    setViewportWidth: (viewportWidth) => set({ viewportWidth }),
    splitHorizontal: (paneASessionId, paneBSessionId) =>
      set({ split: { mode: "horizontal", paneA: paneASessionId, paneB: paneBSessionId, ratio: 0.5 } }),
    splitVertical: (paneASessionId, paneBSessionId) =>
      set({ split: { mode: "vertical", paneA: paneASessionId, paneB: paneBSessionId, ratio: 0.5 } }),
    closeSplit: () =>
      set({ split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } }),
    setSplitRatio: (ratio) =>
      set((s) => ({ split: { ...s.split, ratio: Math.max(0.2, Math.min(0.8, ratio)) } })),
    setSplitPaneB: (sessionId) =>
      set((s) => sessionId ? { split: { ...s.split, paneB: sessionId } } : { split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } }),
    setSplitPaneA: (sessionId) =>
      set((s) => sessionId ? { split: { ...s.split, paneA: sessionId } } : { split: { ...s.split, paneA: null } }),
    addToast: (toast) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({ toasts: [...s.toasts.slice(-2), { ...toast, id }] }));
    },
    removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setHostKeyPrompt: (hostKeyPrompt) => set({ hostKeyPrompt }),
    setPendingWorkflow: (pendingWorkflow) => set({ pendingWorkflow }),
    toggleDirCollapsed: (dir) =>
      set((s) => {
        if (s.collapsedDirs[dir]) {
          const { [dir]: _, ...rest } = s.collapsedDirs;
          return { collapsedDirs: rest };
        }
        return { collapsedDirs: { ...s.collapsedDirs, [dir]: true } };
      }),
    recordCommandUse: (id) =>
      set((s) => {
        const next = { ...s.commandUsage, [id]: Date.now() };
        const entries = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, 50);
        return { commandUsage: Object.fromEntries(entries) };
      }),
    setExternalEditor: (externalEditor) => set({ externalEditor: isExternalEditor(externalEditor) ? externalEditor : DEFAULT_SETTINGS.externalEditor }),
    setBellNotification: (bellNotification) => set({ bellNotification: typeof bellNotification === "boolean" ? bellNotification : true }),
    setTerminalClipboardWrite: (terminalClipboardWrite) => set({ terminalClipboardWrite: typeof terminalClipboardWrite === "boolean" ? terminalClipboardWrite : DEFAULT_SETTINGS.terminalClipboardWrite }),
    setTerminalInlineImages: (terminalInlineImages) => set({ terminalInlineImages: typeof terminalInlineImages === "boolean" ? terminalInlineImages : DEFAULT_SETTINGS.terminalInlineImages }),
    setKeybinding: (action, binding) =>
      set((s) => ({ keybindings: { ...s.keybindings, [action]: binding } })),
    resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),
    resetAppearance: () => set((s) => ({ ...DEFAULT_SETTINGS, keybindings: s.keybindings, language: s.language })),
    setLanguage: (language) => {
      const next = isLanguage(language) ? language : DEFAULT_SETTINGS.language;
      applyLanguage(next);
      set({ language: next });
    },
  };
}));

let configHydrating = false;

export async function loadUserConfig(): Promise<void> {
  try {
    const loaded = await loadTunaraConfig();
    const sanitized = sanitizeConfig(loaded.config);
    configHydrating = true;
    applyLanguage(sanitized.language);
    useUIStore.setState({
      ...sanitized,
      configLoaded: true,
      configPath: loaded.path,
      configError: loaded.error ?? null,
    });
    configHydrating = false;
  } catch (e) {
    configHydrating = true;
    useUIStore.setState({
      configLoaded: true,
      configError: e instanceof Error ? e.message : String(e),
    });
    configHydrating = false;
  }
}

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "cursorBlink", "fontSize", "fontFamily", "fontLigatures", "nerdFontFallback", "scrollback", "sidebarWidth", "panelWidth", "terminalTheme", "externalEditor", "bellNotification", "terminalClipboardWrite", "terminalInlineImages", "keybindings", "language"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    const state = useUIStore.getState();
    if (!state.configLoaded || configHydrating) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      saveTunaraConfig(settingsToRawConfig(useUIStore.getState()))
        .then(() => useUIStore.setState({ configError: null }))
        .catch((e) => useUIStore.setState({ configError: e instanceof Error ? e.message : String(e) }));
    }, 300);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);
