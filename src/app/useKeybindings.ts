import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

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
  const isMac =
    navigator.platform.toLowerCase().includes("mac") ||
    navigator.userAgent.toLowerCase().includes("mac");
  return isMac ? e.metaKey : e.ctrlKey;
}

export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        if (ui.split.mode !== "single" && ui.split.paneB) {
          if (st.activeSessionId === ui.split.paneB) {
            const nonPaneB = st.sessions.find((s) => s.id !== ui.split.paneB);
            if (nonPaneB) st.setActive(nonPaneB.id);
          } else {
            st.setActive(ui.split.paneB);
          }
        }
      } else if (k === "k") {
        e.preventDefault();
        useUIStore.getState().setOverlay("command-palette");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
