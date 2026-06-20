import { create } from "zustand";
import type { OverlayType, ThemeType } from "@/ui/types";

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
}

const SETTINGS_KEY = "conduit-appearance";
const DEFAULT_SETTINGS: AppearanceSettings = {
  theme: "light",
  accent: "#c2683c",
  cursorStyle: "bar",
  fontSize: 14,
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

interface UIState extends AppearanceSettings {
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  trafficLightWidth: number;
  split: SplitState;

  toggleSidebar: () => void;
  togglePanel: () => void;
  setOverlay: (o: OverlayType) => void;
  setTheme: (t: ThemeType) => void;
  setAccent: (c: string) => void;
  setCursorStyle: (c: CursorStyle) => void;
  setFontSize: (n: number) => void;
  setTrafficLightWidth: (w: number) => void;
  splitHorizontal: (paneBSessionId: string) => void;
  splitVertical: (paneBSessionId: string) => void;
  closeSplit: () => void;
  setSplitRatio: (ratio: number) => void;
  setSplitPaneB: (sessionId: string | null) => void;
}

export const useUIStore = create<UIState>()((set, get) => {
  const initial = loadSettings();
  const persist = () => {
    const { theme, accent, cursorStyle, fontSize } = get();
    persistSettings({ theme, accent, cursorStyle, fontSize });
  };
  return {
    sidebarVisible: true,
    panelVisible: true,
    overlay: null,
    trafficLightWidth: 0,
    split: { mode: "single", paneB: null, ratio: 0.5 },
    ...initial,

    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    setOverlay: (overlay) => set({ overlay }),
    setTheme: (theme) => {
      set({ theme });
      persist();
    },
    setAccent: (accent) => {
      set({ accent });
      persist();
    },
    setCursorStyle: (cursorStyle) => {
      set({ cursorStyle });
      persist();
    },
    setFontSize: (fontSize) => {
      set({ fontSize });
      persist();
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
});
