// UI 全局状态 store（实施文档 §4.2）
//
// sidebar/panel/overlay/notif 等纯 UI 状态 + 外观设置（主题/强调色/光标/字号）。
// 外观设置持久化到 localStorage,重启后保留。

import { create } from "zustand";
import type { AgentCode, OverlayType, ThemeType, Notification } from "@/ui/types";

export type CursorStyle = "bar" | "block" | "underline";

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
  notifOpen: boolean;
  agentPick: AgentCode;
  notifications: Notification[];

  toggleSidebar: () => void;
  togglePanel: () => void;
  toggleNotif: () => void;
  setOverlay: (o: OverlayType) => void;
  setAgentPick: (a: AgentCode) => void;
  setTheme: (t: ThemeType) => void;
  setAccent: (c: string) => void;
  setCursorStyle: (c: CursorStyle) => void;
  setFontSize: (n: number) => void;
  addNotification: (n: Notification) => void;
  clearNotification: (id: string) => void;
  clearAllNotifications: () => void;
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
    notifOpen: false,
    agentPick: "CC",
    notifications: [],
    ...initial,

    toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
    togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
    toggleNotif: () => set((s) => ({ notifOpen: !s.notifOpen })),
    setOverlay: (overlay) => set({ overlay }),
    setAgentPick: (agentPick) => set({ agentPick }),
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
    addNotification: (n) =>
      set((s) => ({ notifications: [n, ...s.notifications] })),
    clearNotification: (id) =>
      set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
    clearAllNotifications: () => set({ notifications: [] }),
  };
});
