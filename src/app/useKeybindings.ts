import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { DEFAULT_SETTINGS, useUIStore } from "@/state/ui";
import { KEYBINDING_ACTIONS, matchesKeybinding, type KeybindingAction } from "@/modules/config/keybindings";
import { TERMINAL_QUICK_SELECT_EVENT } from "@/modules/terminal/lib/terminal-quick-select";
import { platform } from "@tauri-apps/plugin-os";

const isMac = platform() === "macos";

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
        case "closeSession":
          if (ui.split.mode !== "single" && ui.split.paneB) {
            st.closeSession(ui.split.paneB);
          } else if (st.activeSessionId) {
            st.closeSession(st.activeSessionId);
          }
          break;
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
        case "focusSplitRight": {
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
      if (isEditableTarget(e.target) && !e.metaKey) return;
      const bindings = useUIStore.getState().keybindings;
      for (const action of KEYBINDING_ACTIONS) {
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
