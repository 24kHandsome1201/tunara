import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { OverlayType, ThemeType, TerminalThemeName } from "@/ui/types";

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
  fontSize: number;
  sidebarWidth: number;
  panelWidth: number;
  terminalTheme: TerminalThemeName;
  externalEditor: ExternalEditor;
}

const SETTINGS_KEY = "conduit-appearance";
const DEFAULT_SETTINGS: AppearanceSettings = {
  theme: "light",
  accent: "#c2683c",
  cursorStyle: "bar",
  fontSize: 14,
  sidebarWidth: 272,
  panelWidth: 320,
  terminalTheme: "default",
  externalEditor: "vscode",
};

function isExternalEditor(v: unknown): v is ExternalEditor {
  return v === "vscode" || v === "cursor" || v === "zed" || v === "sublime";
}

function loadSettings(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...(parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system" ? { theme: parsed.theme } : {}),
      ...(typeof parsed.accent === "string" ? { accent: parsed.accent } : {}),
      ...(parsed.cursorStyle === "bar" || parsed.cursorStyle === "block" || parsed.cursorStyle === "underline" ? { cursorStyle: parsed.cursorStyle } : {}),
      ...(typeof parsed.fontSize === "number" ? { fontSize: parsed.fontSize } : {}),
      ...(typeof parsed.sidebarWidth === "number" ? { sidebarWidth: parsed.sidebarWidth } : {}),
      ...(typeof parsed.panelWidth === "number" ? { panelWidth: parsed.panelWidth } : {}),
      ...(parsed.terminalTheme === "default" || parsed.terminalTheme === "catppuccin" || parsed.terminalTheme === "tokyo-night" || parsed.terminalTheme === "one-dark" || parsed.terminalTheme === "solarized" ? { terminalTheme: parsed.terminalTheme } : {}),
      ...(isExternalEditor(parsed.externalEditor) ? { externalEditor: parsed.externalEditor } : {}),
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
  externalEditor: ExternalEditor;

  toggleSidebar: () => void;
  togglePanel: () => void;
  setOverlay: (o: OverlayType) => void;
  setInspectorTab: (t: InspectorTab) => void;
  setTheme: (t: ThemeType) => void;
  setAccent: (c: string) => void;
  setCursorStyle: (c: CursorStyle) => void;
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

    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    setOverlay: (overlay) => set({ overlay }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    setTheme: (theme) => set({ theme }),
    setAccent: (accent) => set({ accent }),
    setCursorStyle: (cursorStyle) => set({ cursorStyle }),
    setFontSize: (fontSize) => set({ fontSize }),
    setTerminalTheme: (terminalTheme) => set({ terminalTheme }),
    setSidebarWidth: (sidebarWidth) => {
      set({ sidebarWidth: Math.max(200, Math.min(400, sidebarWidth)) });
    },
    setPanelWidth: (panelWidth) => {
      const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
      set({ panelWidth: Math.max(240, Math.min(Math.floor(vw * 0.45), panelWidth)) });
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
    setExternalEditor: (externalEditor) => set({ externalEditor }),
  };
}));

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "fontSize", "sidebarWidth", "panelWidth", "terminalTheme", "externalEditor"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const { theme, accent, cursorStyle, fontSize, sidebarWidth, panelWidth, terminalTheme, externalEditor } = useUIStore.getState();
      persistSettings({ theme, accent, cursorStyle, fontSize, sidebarWidth, panelWidth, terminalTheme, externalEditor });
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
