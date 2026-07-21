import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { DEFAULT_SETTINGS, useUIStore } from "@/state/ui";
import { KEYBINDING_ACTIONS, hasPlatformModKey, matchesKeybinding, type KeybindingAction } from "@/modules/config/keybindings";
import { TERMINAL_QUICK_SELECT_EVENT } from "@/modules/terminal/lib/terminal-quick-select";
import { isMac } from "@/ui/lib/platform";
import {
  canSplitLayout,
  splitFocusTarget,
  splitHorizontalPaneCount,
  splitLayoutSessionIds,
  type SplitFocusDirection,
} from "@/modules/session/split-layout";
import { auxiliarySurfaceToCloseOnOpen, resolveAppShellLayout } from "./lib/app-shell-layout";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    !!target.closest(".xterm") ||
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function useKeybindings() {
  useEffect(() => {
    const runAction = (action: KeybindingAction) => {
      const ui = useUIStore.getState();
      const st = useSessionsStore.getState();
      switch (action) {
        case "newTerminal":
        case "newTerminalAlt":
          st.newTerminal();
          break;
        case "closeSession": {
          const splitSessionIds = splitLayoutSessionIds(ui.split);
          const targetId = st.activeSessionId ?? splitSessionIds[splitSessionIds.length - 1] ?? null;
          if (targetId) st.closeSession(targetId);
          break;
        }
        case "openSettings":
          ui.openSettings();
          break;
        case "toggleSidebar":
          if (!ui.sidebarVisible && auxiliarySurfaceToCloseOnOpen({
            viewportWidth: ui.viewportWidth, sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible,
            sidebarWidth: ui.sidebarWidth, panelWidth: ui.panelWidth, terminalColumnCount: splitHorizontalPaneCount(ui.split),
          }, "sidebar") === "panel") ui.setPanelVisible(false);
          ui.toggleSidebar();
          break;
        case "togglePanel":
          if (!ui.panelVisible && auxiliarySurfaceToCloseOnOpen({
            viewportWidth: ui.viewportWidth, sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible,
            sidebarWidth: ui.sidebarWidth, panelWidth: ui.panelWidth, terminalColumnCount: splitHorizontalPaneCount(ui.split),
          }, "panel") === "sidebar") ui.setSidebarVisible(false);
          ui.togglePanel();
          break;
        case "splitHorizontal":
          if (canSplitLayout(ui.split)) st.splitWithNewSession("horizontal");
          break;
        case "splitVertical":
          if (canSplitLayout(ui.split)) st.splitWithNewSession("vertical");
          break;
        case "focusSplitLeft":
        case "focusSplitRight":
        case "focusSplitUp":
        case "focusSplitDown": {
          const direction = action.replace("focusSplit", "").toLowerCase() as SplitFocusDirection;
          const target = splitFocusTarget(ui.split, st.activeSessionId, direction);
          if (target) st.setActive(target);
          break;
        }
        case "commandPalette":
          ui.setOverlay("command-palette");
          break;
        case "quickSelect":
          window.dispatchEvent(new CustomEvent(TERMINAL_QUICK_SELECT_EVENT));
          break;
        case "fontSizeUp":
          ui.setFontSize(ui.fontSize + 1);
          break;
        case "fontSizeDown":
          ui.setFontSize(ui.fontSize - 1);
          break;
        case "fontSizeReset":
          ui.setFontSize(DEFAULT_SETTINGS.fontSize);
          break;
        case "selectLastTab":
          if (st.sessions.length > 0) st.setActive(st.sessions[st.sessions.length - 1].id);
          break;
        case "cycleNextSession":
          st.cycleSession("next");
          break;
        case "cyclePrevSession":
          st.cycleSession("prev");
          break;
        default: {
          const tabMatch = action.match(/^selectTab([1-8])$/);
          if (!tabMatch) break;
          const idx = Number(tabMatch[1]) - 1;
          if (idx < st.sessions.length) st.setActive(st.sessions[idx].id);
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const ui = useUIStore.getState();
        const compactLayout = resolveAppShellLayout({
          viewportWidth: ui.viewportWidth,
          sidebarVisible: ui.sidebarVisible,
          panelVisible: ui.panelVisible,
          sidebarWidth: ui.sidebarWidth,
          panelWidth: ui.panelWidth,
          terminalColumnCount: splitHorizontalPaneCount(ui.split),
        });
        if (ui.overlay) {
          e.preventDefault();
          ui.setOverlay(null);
          return;
        }
        if (!isEditableTarget(e.target) && compactLayout.panelOverlay && ui.panelVisible) {
          e.preventDefault();
          ui.setPanelVisible(false);
          return;
        }
        if (!isEditableTarget(e.target) && compactLayout.sidebarOverlay && ui.sidebarVisible) {
          e.preventDefault();
          ui.setSidebarVisible(false);
          return;
        }
      }
      if (isEditableTarget(e.target) && !hasPlatformModKey(e, isMac)) return;
      const bindings = useUIStore.getState().keybindings;
      for (const action of KEYBINDING_ACTIONS) {
        // Block navigation is handled per-terminal via xterm's custom key handler
        // because it needs the active terminal instance. Leave the event alone here.
        if (action === "navigatePrevBlock" || action === "navigateNextBlock") continue;
        if (!matchesKeybinding(e, bindings[action], isMac)) continue;
        e.preventDefault();
        runAction(action);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
