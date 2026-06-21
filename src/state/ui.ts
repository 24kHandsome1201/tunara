import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { TERMINAL_THEME_NAMES, type OverlayType, type ThemeType, type TerminalThemeName } from "@/ui/types";

export type CursorStyle = "bar" | "block" | "underline";

export type SplitMode = "single" | "horizontal" | "vertical";

export interface SplitState {
  mode: SplitMode;
  paneA: string | null;
  paneB: string | null;
  ratio: number;
}

interface AppearanceSettings {
  theme: ThemeType;
  accent: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  fontSize: number;
  sidebarWidth: number;
  panelWidth: number;
  terminalTheme: TerminalThemeName;
  externalEditor: ExternalEditor;
}

const SETTINGS_KEY = "conduit-appearance";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 22;
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
  sidebarWidth: 272,
  panelWidth: 320,
  terminalTheme: "default",
  externalEditor: "vscode",
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

function loadSettings(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      ...DEFAULT_SETTINGS,
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      accent: sanitizeAccent(parsed.accent),
      cursorStyle: isCursorStyle(parsed.cursorStyle) ? parsed.cursorStyle : DEFAULT_SETTINGS.cursorStyle,
      cursorBlink: typeof parsed.cursorBlink === "boolean" ? parsed.cursorBlink : DEFAULT_SETTINGS.cursorBlink,
      fontSize: clampNumber(parsed.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SETTINGS.fontSize),
      sidebarWidth: clampNumber(parsed.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SETTINGS.sidebarWidth),
      panelWidth: clampNumber(parsed.panelWidth, MIN_PANEL_WIDTH, maxPanelWidth(), DEFAULT_SETTINGS.panelWidth),
      terminalTheme: isTerminalTheme(parsed.terminalTheme) ? parsed.terminalTheme : DEFAULT_SETTINGS.terminalTheme,
      externalEditor: isExternalEditor(parsed.externalEditor) ? parsed.externalEditor : DEFAULT_SETTINGS.externalEditor,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(s: AppearanceSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

const COMMAND_USAGE_KEY = "conduit-command-usage";

function loadCommandUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COMMAND_USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function persistCommandUsage(usage: Record<string, number>) {
  try {
    localStorage.setItem(COMMAND_USAGE_KEY, JSON.stringify(usage));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export type InspectorTab = "changes" | "files";

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

interface UIState extends AppearanceSettings {
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  trafficLightWidth: number;
  viewportWidth: number;
  split: SplitState;
  inspectorTab: InspectorTab;
  toasts: Toast[];
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
  toggleDirCollapsed: (dir: string) => void;
  recordCommandUse: (id: string) => void;
  setExternalEditor: (e: ExternalEditor) => void;
  resetAppearance: () => void;
}

export const useUIStore = create<UIState>()(subscribeWithSelector((set) => {
  const initial = loadSettings();
  return {
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    trafficLightWidth: 0,
    viewportWidth: typeof window === "undefined" ? 1200 : window.innerWidth,
    split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
    inspectorTab: "changes" as InspectorTab,
    toasts: [],
    collapsedDirs: {},
    commandUsage: loadCommandUsage(),
    ...initial,

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
    resetAppearance: () => set({ ...DEFAULT_SETTINGS }),
  };
}));

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "cursorBlink", "fontSize", "sidebarWidth", "panelWidth", "terminalTheme", "externalEditor"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const { theme, accent, cursorStyle, cursorBlink, fontSize, sidebarWidth, panelWidth, terminalTheme, externalEditor } = useUIStore.getState();
      persistSettings({ theme, accent, cursorStyle, cursorBlink, fontSize, sidebarWidth, panelWidth, terminalTheme, externalEditor });
    }, 300);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);

let commandUsagePersistTimer: ReturnType<typeof setTimeout> | null = null;
useUIStore.subscribe(
  (s) => s.commandUsage,
  () => {
    if (commandUsagePersistTimer) clearTimeout(commandUsagePersistTimer);
    commandUsagePersistTimer = setTimeout(() => {
      persistCommandUsage(useUIStore.getState().commandUsage);
    }, 500);
  },
);
