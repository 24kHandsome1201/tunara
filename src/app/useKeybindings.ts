import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { DEFAULT_SETTINGS, useUIStore } from "@/state/ui";
import { KEYBINDING_ACTIONS, hasPlatformModKey, matchesKeybinding, type KeybindingAction } from "@/modules/config/keybindings";
import { TERMINAL_QUICK_SELECT_EVENT } from "@/modules/terminal/lib/terminal-quick-select";
import { isMac } from "@/ui/lib/platform";

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
          const targetId = st.activeSessionId ?? (ui.split.mode !== "single" ? ui.split.paneB : null);
          if (targetId) st.closeSession(targetId);
          break;
        }
        case "openSettings":
          ui.setOverlay("settings");
          break;
        case "toggleSidebar":
          ui.toggleSidebar();
          break;
        case "togglePanel":
          ui.togglePanel();
          break;
        case "splitHorizontal":
          if (ui.split.mode === "single") st.splitWithNewSession("horizontal");
          break;
        case "splitVertical":
          if (ui.split.mode === "single") st.splitWithNewSession("vertical");
          break;
        case "focusSplitLeft":
        case "focusSplitRight":
        case "focusSplitUp":
        case "focusSplitDown": {
          const { paneA, paneB } = ui.split;
          if (ui.split.mode !== "single" && paneA && paneB) {
            st.setActive(st.activeSessionId === paneB ? paneA : paneB);
          }
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
        if (ui.overlay) {
          e.preventDefault();
          ui.setOverlay(null);
          return;
        }
        if (!isEditableTarget(e.target) && ui.viewportWidth < 720 && ui.sidebarVisible) {
          e.preventDefault();
          ui.setSidebarVisible(false);
          return;
        }
        if (!isEditableTarget(e.target) && ui.viewportWidth < 900 && ui.panelVisible) {
          e.preventDefault();
          ui.setPanelVisible(false);
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
