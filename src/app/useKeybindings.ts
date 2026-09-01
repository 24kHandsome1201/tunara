import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { DEFAULT_SETTINGS, useUIStore } from "@/state/ui";
import { KEYBINDING_ACTIONS, hasPlatformModKey, isFixedTerminalMenuEvent, isTerminalKeybindingAction, matchesKeybinding, type KeybindingAction } from "@/modules/config/keybindings";
import { nextAttentionSessionId } from "@/modules/session/session-attention";
import { t } from "@/modules/i18n";
import { isMac } from "@/ui/lib/platform";
import {
  canSplitLayout,
  splitFocusTarget,
  splitHorizontalPaneCount,
  splitLayoutSessionIds,
  type SplitFocusDirection,
} from "@/modules/session/split-layout";
import { auxiliarySurfaceToCloseOnOpen, resolveAppShellLayout } from "./lib/app-shell-layout";
import { announceTerminalContext } from "@/modules/terminal/lib/terminal-context-announcement";
import { advanceTerminalFocusEpoch } from "@/modules/terminal/lib/binding-aware-async-action";
import {
  handleFileSurfaceClose,
  handleFileSurfaceCycle,
  handleFileSurfaceSelectIndex,
  handleFileSurfaceSelectLast,
} from "@/ui/lib/workspace-tab-actions";

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
      const announcePureNavigation = (previousSessionId: string | null) => {
        const current = useSessionsStore.getState();
        if (ui.presentationMode !== "pure" || !current.activeSessionId || current.activeSessionId === previousSessionId) return;
        const index = current.sessions.findIndex((session) => session.id === current.activeSessionId);
        announceTerminalContext({ reason: "keyboard-navigation", logicalSessionId: current.activeSessionId, index: index + 1, total: current.sessions.length });
      };
      switch (action) {
        case "newTerminal":
        case "newTerminalAlt":
          ui.showTerminal();
          st.newTerminal();
          break;
        case "closeSession": {
          if (handleFileSurfaceClose()) break;
          const splitSessionIds = splitLayoutSessionIds(ui.split);
          const targetId = st.activeSessionId ?? splitSessionIds[splitSessionIds.length - 1] ?? null;
          if (targetId) st.closeSession(targetId);
          break;
        }
        case "openSettings":
          if (ui.presentationMode === "workspace") ui.openSettings();
          break;
        case "toggleSidebar":
          if (ui.presentationMode === "pure") break;
          if (!ui.sidebarVisible && auxiliarySurfaceToCloseOnOpen({
            viewportWidth: ui.viewportWidth, sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible,
            sidebarWidth: ui.sidebarWidth, panelWidth: ui.panelWidth, terminalColumnCount: splitHorizontalPaneCount(ui.split),
          }, "sidebar") === "panel") ui.setPanelVisible(false);
          ui.toggleSidebar();
          break;
        case "togglePanel":
          if (ui.presentationMode === "pure") break;
          ui.showTerminal();
          if (!ui.panelVisible && auxiliarySurfaceToCloseOnOpen({
            viewportWidth: ui.viewportWidth, sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible,
            sidebarWidth: ui.sidebarWidth, panelWidth: ui.panelWidth, terminalColumnCount: splitHorizontalPaneCount(ui.split),
          }, "panel") === "sidebar") ui.setSidebarVisible(false);
          ui.togglePanel();
          break;
        case "splitHorizontal":
          ui.showTerminal();
          if (canSplitLayout(ui.split)) st.splitWithNewSession("horizontal");
          break;
        case "splitVertical":
          ui.showTerminal();
          if (canSplitLayout(ui.split)) st.splitWithNewSession("vertical");
          break;
        case "focusSplitLeft":
        case "focusSplitRight":
        case "focusSplitUp":
        case "focusSplitDown": {
          const direction = action.replace("focusSplit", "").toLowerCase() as SplitFocusDirection;
          const target = splitFocusTarget(ui.split, st.activeSessionId, direction);
          if (target) { const previous = st.activeSessionId; st.setActive(target); ui.showTerminal(); announcePureNavigation(previous); }
          break;
        }
        case "commandPalette":
          ui.setOverlay("command-palette");
          break;
        case "togglePresentationMode":
          ui.togglePresentationMode();
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
          if (handleFileSurfaceSelectLast()) break;
          if (st.sessions.length > 0) { const previous = st.activeSessionId; st.setActive(st.sessions[st.sessions.length - 1].id); ui.showTerminal(); announcePureNavigation(previous); }
          break;
        case "cycleNextSession": {
          if (handleFileSurfaceCycle("next")) break;
          const previous = st.activeSessionId;
          st.cycleSession("next");
          ui.showTerminal();
          announcePureNavigation(previous);
          break;
        }
        case "cyclePrevSession": {
          if (handleFileSurfaceCycle("prev")) break;
          const previous = st.activeSessionId;
          st.cycleSession("prev");
          ui.showTerminal();
          announcePureNavigation(previous);
          break;
        }
        case "focusLatestAttention": {
          const target = nextAttentionSessionId(st.sessions, st.activeSessionId);
          if (!target) {
            ui.addToast({ title: t("attention.none"), subtitle: t("attention.none_hint"), variant: "warning" });
            break;
          }
          const previous = st.activeSessionId;
          st.setActive(target);
          ui.showTerminal();
          announcePureNavigation(previous);
          break;
        }
        default: {
          const tabMatch = action.match(/^selectTab([1-8])$/);
          if (!tabMatch) break;
          const idx = Number(tabMatch[1]) - 1;
          if (handleFileSurfaceSelectIndex(idx)) break;
          if (idx < st.sessions.length) { const previous = st.activeSessionId; st.setActive(st.sessions[idx].id); ui.showTerminal(); announcePureNavigation(previous); }
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
      // These exact chords are fixed terminal-menu recovery paths. Do not let
      // a hand-edited app binding run first in capture phase and double-execute
      // with the terminal menu. Modified variants remain configurable.
      if (isFixedTerminalMenuEvent(e)) return;
      const bindings = useUIStore.getState().keybindings;
      for (const action of KEYBINDING_ACTIONS) {
        // Terminal-scoped Copy/Safe Paste/Menu actions are resolved by the
        // registered xterm instance, which owns selection and paste identity.
        if (isTerminalKeybindingAction(action)) continue;
        // Block navigation is handled per-terminal via xterm's custom key handler
        // because it needs the active terminal instance. Leave the event alone here.
        if (action === "navigatePrevBlock" || action === "navigateNextBlock") continue;
        if (!matchesKeybinding(e, bindings[action], isMac)) continue;
        e.preventDefault();
        advanceTerminalFocusEpoch();
        runAction(action);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
