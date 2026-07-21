import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { TERMINAL_THEME_NAMES, type OverlayType, type ThemeType, type TerminalThemeName, type SshConnectPrefill } from "@/ui/types";
import { loadTunaraConfig, saveTunaraConfig, type RawAppearanceConfig, type RawTunaraConfig } from "@/modules/config/config-bridge";
import { DEFAULT_KEYBINDINGS, keybindingsToConfigKeys, sanitizeKeybindings, type KeybindingAction, type KeybindingConfig } from "@/modules/config/keybindings";
import { isLanguage, setLanguage as applyLanguage, type Language } from "@/modules/i18n";
import { toggleTrueRecordKey } from "@/state/record-keys";
import { persistBootAppearance } from "@/styles/shell-tint-boot";
import {
  emptySplitState,
  insertSplitPane as insertSplitPaneLayout,
  removeSplitPane as removeSplitPaneLayout,
  replaceSplitPane as replaceSplitPaneLayout,
  setSplitRatioAt,
  type SplitDirection,
  type SplitPath,
  type SplitState,
} from "@/modules/session/split-layout";

export type CursorStyle = "bar" | "block" | "underline";
export type PresentationMode = "workspace" | "pure";
export type { SplitState } from "@/modules/session/split-layout";

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
  globalShortcut: string;
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
  globalShortcut: "CmdOrCtrl+Shift+T",
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
    globalShortcut: typeof raw?.global_shortcut === "string" ? raw.global_shortcut : DEFAULT_SETTINGS.globalShortcut,
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
      global_shortcut: s.globalShortcut,
    },
    keybindings: keybindingsToConfigKeys(s.keybindings),
  };
}

export type InspectorTab = "overview" | "timeline" | "changes" | "files" | "preview" | "notes";

export type SettingsTab = "appearance" | "workflows" | "cli" | "app";

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
  /** Optional for app-level failures that are not owned by a terminal session. */
  sessionId?: string;
  title: string;
  subtitle: string;
  variant: "success" | "error" | "warning";
  agentCode?: string;
  action?: {
    kind: "open-settings";
    tab: SettingsTab;
    label: string;
  };
  durationMs?: number;
}

/** A pending SSH host-key confirmation (TOFU). The backend ssh_open call is
 * blocked until the user accepts/rejects the fingerprint. */
export interface HostKeyPrompt {
  promptId: string;
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
  /** "unknown" = first contact (accepting persists to known_hosts);
   *  "unverifiable" = a relevant known_hosts record could not be evaluated
   *  safely — possible rotation/MITM, and accepting does NOT persist. */
  reason: string;
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
  /** Remote workflows fill the existing SSH terminal instead of spawning a
   * local terminal with a remote path. */
  targetSessionId?: string;
}

interface UIState extends AppearanceSettings {
  ready: boolean;
  configLoaded: boolean;
  configPath: string;
  configError: string | null;
  presentationMode: PresentationMode;
  nativeFullscreen: boolean;
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  // 打开 SSH 对话框时的预填值（来自手敲 ssh 检测）。仅瞬态，关闭即清。
  sshPrefill: SshConnectPrefill | null;
  trafficLightWidth: number;
  viewportWidth: number;
  split: SplitState;
  inspectorTab: InspectorTab;
  settingsTab: SettingsTab;
  toasts: Toast[];
  /** FIFO queue of pending host-key confirmations. A queue (not a single slot)
   *  so two SSH connections that both hit an unknown/unverifiable host key
   *  before the first is answered don't clobber each other — each parked
   *  ssh_open needs its own prompt answered or it stays blocked. The dialog
   *  renders the head; answering it shifts to the next. */
  hostKeyPrompts: HostKeyPrompt[];
  pendingWorkflow: PendingWorkflow | null;
  collapsedDirs: Record<string, true>;
  collapsedDiffSections: Record<string, true>;
  commandUsage: Record<string, number>;

  setPresentationMode: (mode: PresentationMode) => void;
  togglePresentationMode: () => void;
  setNativeFullscreen: (fullscreen: boolean) => void;
  setSidebarVisible: (visible: boolean) => void;
  setPanelVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setOverlay: (o: OverlayType) => void;
  openSshConnect: (prefill?: SshConnectPrefill | null) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setSettingsTab: (t: SettingsTab) => void;
  openSettings: (tab?: SettingsTab) => void;
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
  splitPane: (targetSessionId: string, newSessionId: string, direction: SplitDirection) => boolean;
  replaceSplitPane: (targetSessionId: string, newSessionId: string) => void;
  removeSplitPane: (sessionId: string) => string | null;
  closeSplit: () => void;
  setSplitRatio: (path: SplitPath, ratio: number) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  /** Append a host-key prompt to the queue (no-op if its promptId is already
   *  queued, so a duplicate backend event can't double-enqueue). */
  enqueueHostKeyPrompt: (prompt: HostKeyPrompt) => void;
  /** Remove a resolved host-key prompt by promptId, advancing the queue head. */
  dismissHostKeyPrompt: (promptId: string) => void;
  setPendingWorkflow: (workflow: PendingWorkflow | null) => void;
  toggleDirCollapsed: (dir: string) => void;
  toggleDiffSectionCollapsed: (section: string) => void;
  recordCommandUse: (id: string) => void;
  setExternalEditor: (e: ExternalEditor) => void;
  setBellNotification: (b: boolean) => void;
  setTerminalClipboardWrite: (enabled: boolean) => void;
  setTerminalInlineImages: (enabled: boolean) => void;
  setGlobalShortcut: (shortcut: string) => void;
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
    presentationMode: "workspace",
    nativeFullscreen: false,
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    sshPrefill: null,
    trafficLightWidth: 0,
    viewportWidth: typeof window === "undefined" ? 1200 : window.innerWidth,
    split: emptySplitState(),
    inspectorTab: "overview" as InspectorTab,
    settingsTab: "appearance" as SettingsTab,
    toasts: [],
    hostKeyPrompts: [],
    pendingWorkflow: null,
    collapsedDirs: {},
    collapsedDiffSections: {},
    // Hydrated from the workspace snapshot in useInit; starts empty.
    commandUsage: {},
    ...DEFAULT_SETTINGS,

    setPresentationMode: (presentationMode) => set(presentationMode === "pure"
      ? {
          presentationMode,
          overlay: null,
          sshPrefill: null,
          pendingWorkflow: null,
        }
      : { presentationMode, overlay: null, sshPrefill: null }),
    togglePresentationMode: () => set((state) => state.presentationMode === "workspace"
      ? {
          presentationMode: "pure",
          overlay: null,
          sshPrefill: null,
          pendingWorkflow: null,
        }
      : { presentationMode: "workspace", overlay: null, sshPrefill: null }),
    setNativeFullscreen: (nativeFullscreen) => set({ nativeFullscreen }),
    setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
    setPanelVisible: (panelVisible) => set({ panelVisible }),
    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    setOverlay: (overlay) => set(overlay === "ssh" ? { overlay } : { overlay, sshPrefill: null }),
    openSshConnect: (prefill) => set({ overlay: "ssh", sshPrefill: prefill ?? null }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    setSettingsTab: (settingsTab) => set({ settingsTab }),
    openSettings: (settingsTab) => set((state) => ({
      overlay: "settings",
      settingsTab: settingsTab ?? state.settingsTab,
      sshPrefill: null,
    })),
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
    splitPane: (targetSessionId, newSessionId, direction) => {
      let inserted = false;
      set((state) => {
        const split = insertSplitPaneLayout(state.split, targetSessionId, newSessionId, direction);
        if (!split) return {};
        inserted = true;
        return { split };
      });
      return inserted;
    },
    replaceSplitPane: (targetSessionId, newSessionId) =>
      set((state) => ({ split: replaceSplitPaneLayout(state.split, targetSessionId, newSessionId) })),
    removeSplitPane: (sessionId) => {
      let focusSessionId: string | null = null;
      set((state) => {
        const result = removeSplitPaneLayout(state.split, sessionId);
        if (!result.removed) return {};
        focusSessionId = result.focusSessionId;
        return { split: result.split };
      });
      return focusSessionId;
    },
    closeSplit: () => set({ split: emptySplitState() }),
    setSplitRatio: (path, ratio) =>
      set((state) => ({ split: setSplitRatioAt(state.split, path, ratio) })),
    addToast: (toast) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // I8: keep the last 6 toasts (was 3). Batch operations like "close all
      // sessions" can fan out several notifications; capping at 3 dropped
      // signal. 6 still fits the bottom-right stack without overflow on a
      // typical viewport, and the auto-dismiss timer keeps the queue short.
      set((s) => ({ toasts: [...s.toasts.slice(-5), { ...toast, id }] }));
    },
    removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    enqueueHostKeyPrompt: (prompt) =>
      set((s) =>
        s.hostKeyPrompts.some((p) => p.promptId === prompt.promptId)
          ? {}
          : { hostKeyPrompts: [...s.hostKeyPrompts, prompt] },
      ),
    dismissHostKeyPrompt: (promptId) =>
      set((s) => ({ hostKeyPrompts: s.hostKeyPrompts.filter((p) => p.promptId !== promptId) })),
    setPendingWorkflow: (pendingWorkflow) => set({ pendingWorkflow }),
    toggleDirCollapsed: (dir) =>
      set((s) => ({ collapsedDirs: toggleTrueRecordKey(s.collapsedDirs, dir) })),
    toggleDiffSectionCollapsed: (section) =>
      set((s) => ({ collapsedDiffSections: toggleTrueRecordKey(s.collapsedDiffSections, section) })),
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
    setGlobalShortcut: (globalShortcut) => set({ globalShortcut: typeof globalShortcut === "string" ? globalShortcut : DEFAULT_SETTINGS.globalShortcut }),
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
    persistBootAppearance({
      theme: sanitized.theme,
      terminalTheme: sanitized.terminalTheme,
      accent: sanitized.accent,
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

useUIStore.subscribe(
  (s) => [s.theme, s.terminalTheme, s.accent] as const,
  ([theme, terminalTheme, accent]) => {
    const state = useUIStore.getState();
    if (!state.configLoaded || configHydrating) return;
    persistBootAppearance({ theme, terminalTheme, accent });
  },
  { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
);

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "cursorBlink", "fontSize", "fontFamily", "fontLigatures", "nerdFontFallback", "scrollback", "sidebarWidth", "panelWidth", "terminalTheme", "externalEditor", "bellNotification", "terminalClipboardWrite", "terminalInlineImages", "keybindings", "language", "globalShortcut"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let configPersistQueue = Promise.resolve();

function enqueueConfigSave(settings: RawTunaraConfig): Promise<void> {
  const operation = configPersistQueue.then(() => saveTunaraConfig(settings));
  // Keep the queue usable after an individual write failure while preserving
  // invocation order and last-write-wins semantics.
  configPersistQueue = operation.catch(() => {});
  return operation;
}

useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    const state = useUIStore.getState();
    if (!state.configLoaded || configHydrating) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      enqueueConfigSave(settingsToRawConfig(useUIStore.getState()))
        .then(() => useUIStore.setState({ configError: null }))
        .catch((e) => useUIStore.setState({ configError: e instanceof Error ? e.message : String(e) }));
    }, 300);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);
