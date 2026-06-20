import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { OverlayType, ThemeType, TerminalThemeName } from "@/ui/types";

export type CursorStyle = "bar" | "block" | "underline";

export type SplitMode = "single" | "horizontal" | "vertical";

export interface SplitState {
  mode: SplitMode;
  paneB: string | null;
  ratio: number;
}

interface AppearanceSettings {
  theme: ThemeType;
  accent: string;
  cursorStyle: CursorStyle;
  fontSize: number;
  sidebarWidth: number;
  terminalTheme: TerminalThemeName;
}

const SETTINGS_KEY = "conduit-appearance";
const DEFAULT_SETTINGS: AppearanceSettings = {
  theme: "light",
  accent: "#c2683c",
  cursorStyle: "bar",
  fontSize: 14,
  sidebarWidth: 272,
  terminalTheme: "default",
};

function loadSettings(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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

export type InspectorTab = "changes" | "files";

interface UIState extends AppearanceSettings {
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  trafficLightWidth: number;
  split: SplitState;
  inspectorTab: InspectorTab;

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
  setTrafficLightWidth: (w: number) => void;
  splitHorizontal: (paneBSessionId: string) => void;
  splitVertical: (paneBSessionId: string) => void;
  closeSplit: () => void;
  setSplitRatio: (ratio: number) => void;
  setSplitPaneB: (sessionId: string | null) => void;
}

export const useUIStore = create<UIState>()(subscribeWithSelector((set) => {
  const initial = loadSettings();
  return {
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    trafficLightWidth: 0,
    split: { mode: "single", paneB: null, ratio: 0.5 },
    inspectorTab: "changes" as InspectorTab,
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
    setTrafficLightWidth: (trafficLightWidth) => set({ trafficLightWidth }),
    splitHorizontal: (paneBSessionId) =>
      set({ split: { mode: "horizontal", paneB: paneBSessionId, ratio: 0.5 } }),
    splitVertical: (paneBSessionId) =>
      set({ split: { mode: "vertical", paneB: paneBSessionId, ratio: 0.5 } }),
    closeSplit: () =>
      set({ split: { mode: "single", paneB: null, ratio: 0.5 } }),
    setSplitRatio: (ratio) =>
      set((s) => ({ split: { ...s.split, ratio: Math.max(0.2, Math.min(0.8, ratio)) } })),
    setSplitPaneB: (sessionId) =>
      set((s) => sessionId ? { split: { ...s.split, paneB: sessionId } } : { split: { mode: "single", paneB: null, ratio: 0.5 } }),
  };
}));

const PERSIST_KEYS: (keyof AppearanceSettings)[] = ["theme", "accent", "cursorStyle", "fontSize", "sidebarWidth", "terminalTheme"];

let persistTimer: ReturnType<typeof setTimeout> | null = null;
useUIStore.subscribe(
  (s) => PERSIST_KEYS.map((k) => s[k]),
  () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const { theme, accent, cursorStyle, fontSize, sidebarWidth, terminalTheme } = useUIStore.getState();
      persistSettings({ theme, accent, cursorStyle, fontSize, sidebarWidth, terminalTheme });
    }, 300);
  },
  { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
);
