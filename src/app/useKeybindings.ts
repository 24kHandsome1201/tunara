import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { DEFAULT_SETTINGS, useUIStore } from "@/state/ui";
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

function hasAppModifier(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

export function useKeybindings() {
  useEffect(() => {
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
      if (!hasAppModifier(e) || e.altKey) return;
      if (isEditableTarget(e.target) && !e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "t" || k === "n") {
        e.preventDefault();
        useSessionsStore.getState().newTerminal();
      } else if (k === "w") {
        e.preventDefault();
        const ui = useUIStore.getState();
        const st = useSessionsStore.getState();
        if (ui.split.mode !== "single" && ui.split.paneB) {
          st.closeSession(ui.split.paneB);
        } else if (st.activeSessionId) {
          st.closeSession(st.activeSessionId);
        }
      } else if (k === ",") {
        e.preventDefault();
        useUIStore.getState().setOverlay("settings");
      } else if (k === "\\") {
        e.preventDefault();
        if (e.shiftKey) {
          useUIStore.getState().togglePanel();
        } else {
          useUIStore.getState().toggleSidebar();
        }
      } else if (k === "d") {
        e.preventDefault();
        const ui = useUIStore.getState();
        if (ui.split.mode !== "single") return;
        useSessionsStore.getState().splitWithNewSession(e.shiftKey ? "vertical" : "horizontal");
      } else if (k === "]" || k === "[") {
        e.preventDefault();
        const ui = useUIStore.getState();
        const st = useSessionsStore.getState();
        const { paneA, paneB } = ui.split;
        if (ui.split.mode !== "single" && paneA && paneB) {
          st.setActive(st.activeSessionId === paneB ? paneA : paneB);
        }
      } else if (k === "k") {
        e.preventDefault();
        useUIStore.getState().setOverlay("command-palette");
      } else if (k === "=" || k === "+") {
        e.preventDefault();
        const ui = useUIStore.getState();
        ui.setFontSize(ui.fontSize + 1);
      } else if (k === "-") {
        e.preventDefault();
        const ui = useUIStore.getState();
        ui.setFontSize(ui.fontSize - 1);
      } else if (k === "0") {
        e.preventDefault();
        useUIStore.getState().setFontSize(DEFAULT_SETTINGS.fontSize);
      } else if (k >= "1" && k <= "8") {
        e.preventDefault();
        const idx = parseInt(k) - 1;
        const sessions = useSessionsStore.getState().sessions;
        if (idx < sessions.length) {
          useSessionsStore.getState().setActive(sessions[idx].id);
        }
      } else if (k === "9") {
        e.preventDefault();
        const sessions = useSessionsStore.getState().sessions;
        if (sessions.length > 0) {
          useSessionsStore.getState().setActive(sessions[sessions.length - 1].id);
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
