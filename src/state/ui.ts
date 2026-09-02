import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { type OverlayType, type ThemeType, type SshConnectPrefill } from "@/ui/types";
import { loadTunaraConfig, saveTunaraConfig, type RawAppearanceConfig, type RawTunaraConfig } from "@/modules/config/config-bridge";
import { DEFAULT_KEYBINDINGS, keybindingsToConfigKeys, sanitizeKeybindings, TERMINAL_KEYBINDING_ACTIONS, type KeybindingAction, type KeybindingConfig } from "@/modules/config/keybindings";
import { isLanguage, setLanguage as applyLanguage, t, type Language } from "@/modules/i18n";
import { toggleTrueRecordKey } from "@/state/record-keys";
import { persistBootAppearance } from "@/styles/shell-tint-boot";
import {
  canSplitLayout,
  emptySplitState,
  insertReaderPane as insertReaderPaneLayout,
  insertSplitPane as insertSplitPaneLayout,
  readerPaneId,
  removeReaderPane as removeReaderPaneLayout,
  removeSplitPane as removeSplitPaneLayout,
  replaceSplitPane as replaceSplitPaneLayout,
  sessionIdFromPaneId,
  setSplitRatioAt,
  splitLayoutHasReader,
  type SplitDirection,
  type SplitPath,
  type SplitState,
} from "@/modules/session/split-layout";
import {
  openReaderFileInState,
  readerHistoryBack as readerHistoryBackState,
  readerHistoryForward as readerHistoryForwardState,
  readerSelectHistoryIndex,
  type ReaderFileRef,
  type SessionReaderState,
} from "@/modules/session/reader-state";
import { DEFAULT_ACCENT } from "@/styles/shell-tint-boot";
import type { TerminalHostModifier } from "@/modules/terminal/lib/terminal-input-router";

const REMOVED_TERMINAL_THEMES = [
  "catppuccin",
  "tokyo-night",
  "one-dark",
  "solarized",
  "github-light",
  "rose-pine-dawn",
] as const;

export type CursorStyle = "bar" | "block" | "underline";
export type PresentationMode = "workspace" | "pure";
export type MainSurface = "terminal" | "ssh-hosts";
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
  externalEditor: ExternalEditor;
  bellNotification: boolean;
  terminalClipboardWrite: boolean;
  terminalScreenReaderMode: boolean;
  showPureModeFilesButton: boolean;
  terminalHostModifier: TerminalHostModifier;
  keybindings: KeybindingConfig;
  language: Language;
  globalShortcut: string;
}

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 22;
const DEFAULT_SCROLLBACK = 10_000;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 400;
const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH_RATIO = 0.45;

export const DEFAULT_SETTINGS: Readonly<AppearanceSettings> = {
  theme: "light",
  accent: DEFAULT_ACCENT,
  cursorStyle: "bar",
  cursorBlink: true,
  fontSize: 14,
  fontFamily: "JetBrains Mono",
  fontLigatures: false,
  nerdFontFallback: true,
  scrollback: DEFAULT_SCROLLBACK,
  sidebarWidth: 272,
  panelWidth: 320,
  externalEditor: "vscode",
  bellNotification: true,
  terminalClipboardWrite: false,
  terminalScreenReaderMode: false,
  showPureModeFilesButton: true,
  // Cmd on macOS still needs real-hardware/WKWebView verification; Option is
  // available as an alternative. Shift is the conservative Win/Linux choice.
  terminalHostModifier: typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "meta" : "shift",
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

function sanitizeTheme(theme: unknown, terminalTheme: unknown): ThemeType {
  if (typeof terminalTheme === "string" && (REMOVED_TERMINAL_THEMES as readonly string[]).includes(terminalTheme)) {
    return "system";
  }
  return isTheme(theme) ? theme : DEFAULT_SETTINGS.theme;
}

function sanitizeAccent(_value: unknown): string {
  return DEFAULT_SETTINGS.accent;
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
    theme: sanitizeTheme(raw?.theme, raw?.terminal_theme),
    accent: sanitizeAccent(raw?.accent),
    cursorStyle: isCursorStyle(raw?.cursor_style) ? raw.cursor_style : DEFAULT_SETTINGS.cursorStyle,
    cursorBlink: typeof raw?.cursor_blink === "boolean" ? raw.cursor_blink : DEFAULT_SETTINGS.cursorBlink,
    fontSize: clampNumber(raw?.font_size, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS.fontSize),
    fontFamily: sanitizeFontFamily(raw?.font_family),
    fontLigatures: typeof raw?.font_ligatures === "boolean" ? raw.font_ligatures : DEFAULT_SETTINGS.fontLigatures,
    nerdFontFallback: typeof raw?.nerd_font_fallback === "boolean" ? raw.nerd_font_fallback : DEFAULT_SETTINGS.nerdFontFallback,
    scrollback: DEFAULT_SCROLLBACK,
    sidebarWidth: clampNumber(raw?.sidebar_width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SETTINGS.sidebarWidth),
    panelWidth: clampNumber(raw?.panel_width, MIN_PANEL_WIDTH, maxPanelWidth(), DEFAULT_SETTINGS.panelWidth),
    externalEditor: isExternalEditor(raw?.external_editor) ? raw.external_editor : DEFAULT_SETTINGS.externalEditor,
    bellNotification: typeof raw?.bell_notification === "boolean" ? raw.bell_notification : DEFAULT_SETTINGS.bellNotification,
    terminalClipboardWrite: typeof raw?.terminal_clipboard_write === "boolean" ? raw.terminal_clipboard_write : DEFAULT_SETTINGS.terminalClipboardWrite,
    terminalScreenReaderMode: typeof raw?.terminal_screen_reader_mode === "boolean" ? raw.terminal_screen_reader_mode : DEFAULT_SETTINGS.terminalScreenReaderMode,
    showPureModeFilesButton: typeof raw?.show_pure_mode_files_button === "boolean" ? raw.show_pure_mode_files_button : DEFAULT_SETTINGS.showPureModeFilesButton,
    terminalHostModifier: raw?.terminal_host_modifier === "meta" || raw?.terminal_host_modifier === "alt" || raw?.terminal_host_modifier === "shift" ? raw.terminal_host_modifier : DEFAULT_SETTINGS.terminalHostModifier,
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
      terminal_theme: "default",
      external_editor: s.externalEditor,
      bell_notification: s.bellNotification,
      terminal_clipboard_write: s.terminalClipboardWrite,
      terminal_inline_images: true,
      terminal_screen_reader_mode: s.terminalScreenReaderMode,
      show_pure_mode_files_button: s.showPureModeFilesButton,
      terminal_host_modifier: s.terminalHostModifier,
      language: s.language,
      global_shortcut: s.globalShortcut,
    },
    keybindings: keybindingsToConfigKeys(s.keybindings),
    terminal_interactions: {
      version: 1,
      secondary_click: "smart",
    },
  };
}

export type InspectorTab = "changes" | "files" | "transfers" | "forwarding" | "preview";

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
    tab: string;
    label: string;
  } | {
    kind: "open-remote-preview";
    sessionId: string;
    path: string;
    label: string;
  };
  durationMs?: number;
}

/** A pending SSH host-key confirmation (TOFU). The backend ssh_open_v2 call is
 * blocked until the user accepts/rejects the fingerprint. */
export interface HostKeyPrompt {
  hopRole: "direct" | "jump" | "target";
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

/** One server-issued keyboard-interactive challenge round. Responses are kept
 * in the dialog component only and are never added to this store. */
export interface KeyboardInteractivePrompt {
  hopRole: "direct" | "jump" | "target";
  origin: {
    user: string; host: string; port: number; logicalSessionId: string;
    hopRole: "direct" | "jump" | "target"; transportGeneration: string;
  };
  promptId: string;
  name: string;
  instructions: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
}

export type { ReaderFileRef, SessionReaderState };

interface UIState extends AppearanceSettings {
  ready: boolean;
  configLoaded: boolean;
  configPath: string;
  configError: string | null;
  presentationMode: PresentationMode;
  mainSurface: MainSurface;
  nativeFullscreen: boolean;
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  // 打开 SSH 对话框时的预填值（来自手敲 ssh 检测）。仅瞬态，关闭即清。
  sshPrefill: SshConnectPrefill | null;
  trafficLightWidth: number;
  viewportWidth: number;
  split: SplitState;
  /** Terminal session id or `reader:<sessionId>` for the focused split leaf. */
  focusedPaneId: string | null;
  readers: Record<string, SessionReaderState>;
  inspectorTab: InspectorTab;
  /** Manual Inspector view hold. Session switch restores follow. */
  inspectorLocked: boolean;
  inspectorLockSessionId: string | null;
  /** Sessions where the user has opened Preview; drives auto-select, not persisted. */
  inspectorPreviewOpenedSessionIds: Record<string, true>;
  toasts: Toast[];
  /** FIFO queue of pending host-key confirmations. A queue (not a single slot)
   *  so two SSH connections that both hit an unknown/unverifiable host key
   *  before the first is answered don't clobber each other — each parked
   *  ssh_open_v2 needs its own prompt answered or it stays blocked. The dialog
   *  renders the head; answering it shifts to the next. */
  hostKeyPrompts: HostKeyPrompt[];
  keyboardInteractivePrompts: KeyboardInteractivePrompt[];
  collapsedDirs: Record<string, true>;
  collapsedDiffSections: Record<string, true>;
  commandUsage: Record<string, number>;
  /** Bumped when saved SSH profiles or ~/.ssh/config import results change. Not persisted. */
  sshProfilesEpoch: number;
  explorerFollowCwd: boolean;
  downloadMaxFiles: number;
  downloadMaxFileBytes: number;
  downloadMaxTotalBytes: number;

  setPresentationMode: (mode: PresentationMode) => void;
  togglePresentationMode: () => void;
  showTerminal: () => void;
  openSshHosts: () => void;
  setNativeFullscreen: (fullscreen: boolean) => void;
  setExplorerFollowCwd: (enabled: boolean) => void;
  setDownloadLimits: (limits: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number }) => void;
  setSidebarVisible: (visible: boolean) => void;
  setPanelVisible: (visible: boolean) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setOverlay: (o: OverlayType) => void;
  openSshConnect: (prefill?: SshConnectPrefill | null) => void;
  setInspectorTab: (t: InspectorTab, options?: { lock?: boolean; sessionId?: string | null }) => void;
  lockInspectorView: (sessionId?: string | null) => void;
  unlockInspectorView: () => void;
  syncInspectorLockForSession: (sessionId: string | null) => void;
  markInspectorPreviewOpened: (sessionId: string) => void;
  clearInspectorPreviewOpened: (sessionId: string) => void;
  openReader: (file: ReaderFileRef & { sessionId: string }) => boolean;
  closeReaderPane: (sessionId: string) => void;
  closeReaderForSession: (sessionId: string) => void;
  setReaderDirty: (sessionId: string, dirty: boolean) => void;
  readerHistoryBack: (sessionId: string) => void;
  readerHistoryForward: (sessionId: string) => void;
  selectReaderHistory: (sessionId: string, index: number) => void;
  setFocusedPaneId: (paneId: string | null) => void;
  activateTerminal: () => void;
  openSettings: (section?: string) => void;
  setTheme: (t: ThemeType) => void;
  setCursorStyle: (c: CursorStyle) => void;
  setCursorBlink: (b: boolean) => void;
  setFontSize: (n: number) => void;
  setFontFamily: (name: string) => void;
  setFontLigatures: (enabled: boolean) => void;
  setNerdFontFallback: (enabled: boolean) => void;
  setTerminalScreenReaderMode: (enabled: boolean) => void;
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
  enqueueKeyboardInteractivePrompt: (prompt: KeyboardInteractivePrompt) => void;
  dismissKeyboardInteractivePrompt: (promptId: string) => void;
  bumpSshProfilesEpoch: () => void;
  toggleDirCollapsed: (dir: string) => void;
  toggleDiffSectionCollapsed: (section: string) => void;
  recordCommandUse: (id: string) => void;
  setExternalEditor: (e: ExternalEditor) => void;
  setBellNotification: (b: boolean) => void;
  setTerminalClipboardWrite: (enabled: boolean) => void;
  setShowPureModeFilesButton: (enabled: boolean) => void;
  setTerminalHostModifier: (modifier: TerminalHostModifier) => void;
  resetTerminalInteractions: () => void;
  setGlobalShortcut: (shortcut: string) => void;
  setKeybinding: (action: KeybindingAction, binding: string) => void;
  resetKeybindings: () => void;
  resetAppearance: () => void;
  setLanguage: (lang: Language) => void;
}

const SETTINGS_SECTION_ALIASES: Record<string, string> = {
  general: "appearance",
  appearance: "appearance",
  shortcuts: "terminal",
  terminal: "terminal",
  ssh: "ssh",
  app: "about",
  about: "about",
};

let pendingSettingsSection: string | null = null;

function normalizeSettingsSection(section: unknown): string | null {
  if (typeof section !== "string" || !section) return null;
  return SETTINGS_SECTION_ALIASES[section] ?? section;
}

export function consumePendingSettingsSection(): string | null {
  const section = pendingSettingsSection;
  pendingSettingsSection = null;
  return section;
}

export const useUIStore = create<UIState>()(subscribeWithSelector((set) => {
  return {
    ready: false,
    configLoaded: false,
    configPath: "",
    configError: null,
    presentationMode: "workspace",
    mainSurface: "terminal",
    nativeFullscreen: false,
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    sshPrefill: null,
    trafficLightWidth: 0,
    viewportWidth: typeof window === "undefined" ? 1200 : window.innerWidth,
    split: emptySplitState(),
    focusedPaneId: null,
    readers: {},
    inspectorTab: "changes" as InspectorTab,
    inspectorLocked: false,
    inspectorLockSessionId: null,
    inspectorPreviewOpenedSessionIds: {},
    toasts: [],
    hostKeyPrompts: [],
    keyboardInteractivePrompts: [],
    collapsedDirs: {},
    collapsedDiffSections: {},
    sshProfilesEpoch: 0,
    // Hydrated from the workspace snapshot in useInit; starts empty.
    commandUsage: {},
    explorerFollowCwd: true,
    downloadMaxFiles: 100,
    downloadMaxFileBytes: 100 * 1024 * 1024,
    downloadMaxTotalBytes: 1024 ** 3,
    ...DEFAULT_SETTINGS,

    setPresentationMode: (presentationMode) => set(presentationMode === "pure"
      ? {
          presentationMode,
          mainSurface: "terminal",
          overlay: null,
          sshPrefill: null,
        }
      : { presentationMode, mainSurface: "terminal", overlay: null, sshPrefill: null }),
    togglePresentationMode: () => set((state) => state.presentationMode === "workspace"
      ? {
          presentationMode: "pure",
          mainSurface: "terminal",
          overlay: null,
          sshPrefill: null,
        }
      : { presentationMode: "workspace", mainSurface: "terminal", overlay: null, sshPrefill: null }),
    showTerminal: () => set({ mainSurface: "terminal" }),
    openSshHosts: () => set({
      presentationMode: "workspace",
      mainSurface: "ssh-hosts",
      overlay: null,
      sshPrefill: null,
    }),
    setNativeFullscreen: (nativeFullscreen) => set({ nativeFullscreen }),
    setExplorerFollowCwd: (explorerFollowCwd) => set({ explorerFollowCwd }),
    setDownloadLimits: (limits) => set((s) => ({
      downloadMaxFiles: limits.maxFiles ?? s.downloadMaxFiles,
      downloadMaxFileBytes: limits.maxFileBytes ?? s.downloadMaxFileBytes,
      downloadMaxTotalBytes: limits.maxTotalBytes ?? s.downloadMaxTotalBytes,
    })),
    setSidebarVisible: (sidebarVisible) => set({ sidebarVisible }),
    setPanelVisible: (panelVisible) => set({ panelVisible }),
    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    setOverlay: (overlay) => set(overlay === "ssh" ? { overlay } : { overlay, sshPrefill: null }),
    // Profile/config management stays out of Pure Mode. A user-triggered
    // connect/reconnect first restores the workspace, then opens the sheet.
    openSshConnect: (prefill) => set({
      presentationMode: "workspace",
      overlay: "ssh",
      sshPrefill: prefill ?? null,
    }),
    setInspectorTab: (inspectorTab, options) => set((state) => {
      const lock = options?.lock !== false;
      const sessionId = options?.sessionId === undefined ? state.inspectorLockSessionId : options.sessionId;
      return {
        inspectorTab,
        inspectorLocked: lock,
        inspectorLockSessionId: lock ? sessionId : null,
      };
    }),
    lockInspectorView: (sessionId) => set((state) => ({
      inspectorLocked: true,
      inspectorLockSessionId: sessionId === undefined ? state.inspectorLockSessionId : sessionId,
    })),
    unlockInspectorView: () => set({ inspectorLocked: false, inspectorLockSessionId: null }),
    syncInspectorLockForSession: (sessionId) => set((state) => {
      if (!state.inspectorLocked) return {};
      if (state.inspectorLockSessionId == null) return { inspectorLockSessionId: sessionId };
      if (state.inspectorLockSessionId === sessionId) return {};
      return { inspectorLocked: false, inspectorLockSessionId: null };
    }),
    markInspectorPreviewOpened: (sessionId) => set((state) => (
      state.inspectorPreviewOpenedSessionIds[sessionId]
        ? {}
        : { inspectorPreviewOpenedSessionIds: { ...state.inspectorPreviewOpenedSessionIds, [sessionId]: true } }
    )),
    clearInspectorPreviewOpened: (sessionId) => set((state) => {
      if (!state.inspectorPreviewOpenedSessionIds[sessionId]) return {};
      const inspectorPreviewOpenedSessionIds = { ...state.inspectorPreviewOpenedSessionIds };
      delete inspectorPreviewOpenedSessionIds[sessionId];
      return { inspectorPreviewOpenedSessionIds };
    }),
    openReader: (file) => {
      let opened = false;
      set((state) => {
        const existing = state.readers[file.sessionId];
        const alreadyOpen = splitLayoutHasReader(state.split, file.sessionId);
        if (!alreadyOpen && !canSplitLayout(state.split)) return {};
        const nextReaders = {
          ...state.readers,
          [file.sessionId]: openReaderFileInState(existing, file),
        };
        if (alreadyOpen) {
          opened = true;
          return {
            readers: nextReaders,
            focusedPaneId: readerPaneId(file.sessionId),
            mainSurface: "terminal",
          };
        }
        const split = insertReaderPaneLayout(state.split, file.sessionId);
        if (!split) return {};
        opened = true;
        return {
          readers: nextReaders,
          split,
          focusedPaneId: readerPaneId(file.sessionId),
          mainSurface: "terminal",
        };
      });
      return opened;
    },
    closeReaderPane: (sessionId) => set((state) => {
      const result = removeReaderPaneLayout(state.split, sessionId);
      if (!result.removed) return {};
      const focusedOnThis = state.focusedPaneId === readerPaneId(sessionId);
      return {
        split: result.split,
        focusedPaneId: focusedOnThis
          ? (result.focusPaneId ?? sessionId)
          : state.focusedPaneId,
      };
    }),
    closeReaderForSession: (sessionId) => set((state) => {
      const result = removeReaderPaneLayout(state.split, sessionId);
      const { [sessionId]: _removed, ...readers } = state.readers;
      const focusedOnThis = state.focusedPaneId === readerPaneId(sessionId)
        || sessionIdFromPaneId(state.focusedPaneId ?? "") === sessionId;
      return {
        readers,
        ...(result.removed ? { split: result.split } : {}),
        focusedPaneId: focusedOnThis
          ? (result.focusPaneId ?? null)
          : state.focusedPaneId,
      };
    }),
    setReaderDirty: (sessionId, dirty) => set((state) => {
      const reader = state.readers[sessionId];
      if (!reader || reader.dirty === dirty) return {};
      return { readers: { ...state.readers, [sessionId]: { ...reader, dirty } } };
    }),
    readerHistoryBack: (sessionId) => set((state) => {
      const reader = state.readers[sessionId];
      if (!reader) return {};
      const next = readerHistoryBackState(reader);
      if (next === reader) return {};
      return { readers: { ...state.readers, [sessionId]: next } };
    }),
    readerHistoryForward: (sessionId) => set((state) => {
      const reader = state.readers[sessionId];
      if (!reader) return {};
      const next = readerHistoryForwardState(reader);
      if (next === reader) return {};
      return { readers: { ...state.readers, [sessionId]: next } };
    }),
    selectReaderHistory: (sessionId, index) => set((state) => {
      const reader = state.readers[sessionId];
      if (!reader) return {};
      const next = readerSelectHistoryIndex(reader, index);
      if (next === reader) return {};
      return { readers: { ...state.readers, [sessionId]: next } };
    }),
    setFocusedPaneId: (focusedPaneId) => set({ focusedPaneId }),
    activateTerminal: () => set({ mainSurface: "terminal" }),
    openSettings: (section) => {
      pendingSettingsSection = normalizeSettingsSection(section);
      set({ overlay: "settings", sshPrefill: null });
    },
    setTheme: (theme) => set({ theme: isTheme(theme) ? theme : DEFAULT_SETTINGS.theme }),
    setCursorStyle: (cursorStyle) => set({ cursorStyle: isCursorStyle(cursorStyle) ? cursorStyle : DEFAULT_SETTINGS.cursorStyle }),
    setCursorBlink: (cursorBlink) => set({ cursorBlink: typeof cursorBlink === "boolean" ? cursorBlink : DEFAULT_SETTINGS.cursorBlink }),
    setFontSize: (fontSize) => set({ fontSize: clampNumber(fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS.fontSize) }),
    setFontFamily: (fontFamily) => set({ fontFamily: sanitizeFontFamily(fontFamily) }),
    setFontLigatures: (fontLigatures) => set({ fontLigatures: typeof fontLigatures === "boolean" ? fontLigatures : DEFAULT_SETTINGS.fontLigatures }),
    setNerdFontFallback: (nerdFontFallback) => set({ nerdFontFallback: typeof nerdFontFallback === "boolean" ? nerdFontFallback : DEFAULT_SETTINGS.nerdFontFallback }),
    setTerminalScreenReaderMode: (terminalScreenReaderMode) => set({ terminalScreenReaderMode: typeof terminalScreenReaderMode === "boolean" ? terminalScreenReaderMode : DEFAULT_SETTINGS.terminalScreenReaderMode }),
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
        return { split, focusedPaneId: newSessionId };
      });
      return inserted;
    },
    replaceSplitPane: (targetSessionId, newSessionId) =>
      set((state) => ({
        split: replaceSplitPaneLayout(state.split, targetSessionId, newSessionId),
        focusedPaneId: state.focusedPaneId === targetSessionId ? newSessionId : state.focusedPaneId,
      })),
    removeSplitPane: (sessionId) => {
      let focusSessionId: string | null = null;
      set((state) => {
        const result = removeSplitPaneLayout(state.split, sessionId);
        if (!result.removed) return {};
        focusSessionId = result.focusSessionId;
        const { [sessionId]: _removed, ...readers } = state.readers;
        const focusedOnRemoved = state.focusedPaneId === sessionId
          || state.focusedPaneId === readerPaneId(sessionId);
        return {
          split: result.split,
          readers,
          focusedPaneId: focusedOnRemoved ? (result.focusSessionId ?? null) : state.focusedPaneId,
        };
      });
      return focusSessionId;
    },
    closeSplit: () => set({ split: emptySplitState(), focusedPaneId: null }),
    setSplitRatio: (path, ratio) =>
      set((state) => ({ split: setSplitRatioAt(state.split, path, ratio) })),
    addToast: (toast) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({ toasts: [...s.toasts.slice(-2), { ...toast, id }] }));
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
    enqueueKeyboardInteractivePrompt: (prompt) =>
      set((s) =>
        s.keyboardInteractivePrompts.some((p) => p.promptId === prompt.promptId)
          ? {}
          : { keyboardInteractivePrompts: [...s.keyboardInteractivePrompts, prompt] },
      ),
    dismissKeyboardInteractivePrompt: (promptId) =>
      set((s) => ({
        keyboardInteractivePrompts: s.keyboardInteractivePrompts.filter((p) => p.promptId !== promptId),
      })),
    bumpSshProfilesEpoch: () => set((s) => ({ sshProfilesEpoch: s.sshProfilesEpoch + 1 })),
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
    setShowPureModeFilesButton: (showPureModeFilesButton) => set({ showPureModeFilesButton: typeof showPureModeFilesButton === "boolean" ? showPureModeFilesButton : DEFAULT_SETTINGS.showPureModeFilesButton }),
    setTerminalHostModifier: (terminalHostModifier) => set({ terminalHostModifier }),
    resetTerminalInteractions: () => set((state) => {
      const keybindings = { ...state.keybindings };
      for (const action of TERMINAL_KEYBINDING_ACTIONS) keybindings[action] = DEFAULT_KEYBINDINGS[action];
      return {
        terminalHostModifier: DEFAULT_SETTINGS.terminalHostModifier,
        keybindings,
      };
    }),
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
  (s) => [s.theme, s.accent] as const,
  ([theme, accent]) => {
    const state = useUIStore.getState();
    if (!state.configLoaded || configHydrating) return;
    persistBootAppearance({ theme, accent });
  },
  { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
);

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "cursorBlink", "fontSize", "fontFamily", "fontLigatures", "nerdFontFallback", "scrollback", "sidebarWidth", "panelWidth", "externalEditor", "bellNotification", "terminalClipboardWrite", "terminalScreenReaderMode", "showPureModeFilesButton", "terminalHostModifier", "keybindings", "language", "globalShortcut"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let configPersistQueue = Promise.resolve();
let configPersistFailing = false;

function enqueueConfigSave(settings: RawTunaraConfig): Promise<void> {
  const operation = configPersistQueue.then(() => saveTunaraConfig(settings));
  // Keep the queue usable after an individual write failure while preserving
  // invocation order and last-write-wins semantics.
  configPersistQueue = operation.catch(() => {});
  return operation;
}

function persistCurrentUserConfig(): Promise<void> {
  return enqueueConfigSave(settingsToRawConfig(useUIStore.getState()))
    .then(() => useUIStore.setState({ configError: null }))
    .then(() => { configPersistFailing = false; })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const alreadyFailing = configPersistFailing;
      configPersistFailing = true;
      useUIStore.setState({ configError: message });
      if (!alreadyFailing) {
        useUIStore.getState().addToast({ title: t("settings.config_error"), subtitle: message, variant: "error" });
      }
      throw error;
    });
}

/** Drain the debounced config writer before a process-level restart. */
export async function flushUserConfig(): Promise<boolean> {
  const state = useUIStore.getState();
  if (!state.configLoaded || configHydrating) return false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await persistCurrentUserConfig();
    return true;
  } catch {
    return false;
  }
}

useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    const state = useUIStore.getState();
    if (!state.configLoaded || configHydrating) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistCurrentUserConfig().catch(() => {});
    }, 300);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);
