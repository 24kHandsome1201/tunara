import type { SplitMode } from "@/state/ui";

export const MIN_TERMINAL_PANE_WIDTH = 280;
export const MIN_SINGLE_TERMINAL_WIDTH = 480;
export const SPLIT_HANDLE_WIDTH = 5;
export const MIN_SIDEBAR_OVERLAY_WIDTH = 200;
export const MIN_PANEL_OVERLAY_WIDTH = 240;
const OVERLAY_VIEWPORT_INSET = 24;

export interface AppShellLayoutInput {
  viewportWidth: number;
  sidebarVisible: boolean;
  panelVisible: boolean;
  sidebarWidth: number;
  panelWidth: number;
  splitMode: SplitMode;
}

export interface AppShellLayout {
  sidebarOverlay: boolean;
  panelOverlay: boolean;
  sidebarEffectiveWidth: number;
  panelEffectiveWidth: number;
  sidebarReservedWidth: number;
  panelReservedWidth: number;
  terminalWorkspaceWidth: number;
  minimumTerminalWorkspaceWidth: number;
}

export type AuxiliarySurface = "sidebar" | "panel";

/**
 * Compact drawers are mutually exclusive. Opening one closes the other before
 * it can cover the full terminal, while wide docked panels remain independent.
 */
export function auxiliarySurfaceToCloseOnOpen(
  input: AppShellLayoutInput,
  opening: AuxiliarySurface,
): AuxiliarySurface | null {
  const projected = resolveAppShellLayout({
    ...input,
    sidebarVisible: opening === "sidebar" ? true : input.sidebarVisible,
    panelVisible: opening === "panel" ? true : input.panelVisible,
  });
  if (!projected.sidebarOverlay || !projected.panelOverlay) return null;
  if (opening === "sidebar" && input.panelVisible) return "panel";
  if (opening === "panel" && input.sidebarVisible) return "sidebar";
  return null;
}

function finiteWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Keep the terminal workspace usable before deciding whether auxiliary panels
 * may dock. The Inspector yields first, then the navigation sidebar. This
 * avoids fixed breakpoint cliffs where making the window wider can make a TUI
 * dramatically narrower.
 */
export function resolveAppShellLayout(input: AppShellLayoutInput): AppShellLayout {
  const viewportWidth = finiteWidth(input.viewportWidth);
  const requestedSidebarWidth = input.sidebarVisible ? finiteWidth(input.sidebarWidth) : 0;
  const requestedPanelWidth = input.panelVisible ? finiteWidth(input.panelWidth) : 0;
  const minimumTerminalWorkspaceWidth = input.splitMode === "horizontal"
    ? MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH
    : MIN_SINGLE_TERMINAL_WIDTH;

  // Grow reserved shell space one pixel for every pixel the window gains.
  // The terminal therefore stays flat at its minimum through the transition,
  // then grows again after both panels are fully docked. It can never become
  // narrower merely because the viewport crossed a dock breakpoint.
  let availableReservation = Math.max(0, viewportWidth - minimumTerminalWorkspaceWidth);
  const sidebarReservedWidth = Math.min(requestedSidebarWidth, availableReservation);
  availableReservation -= sidebarReservedWidth;
  const panelReservedWidth = Math.min(requestedPanelWidth, availableReservation);

  const sidebarOverlay = input.sidebarVisible && sidebarReservedWidth < requestedSidebarWidth;
  const panelOverlay = input.panelVisible && panelReservedWidth < requestedPanelWidth;

  const overlayWidthLimit = Math.max(0, viewportWidth - OVERLAY_VIEWPORT_INSET);
  let sidebarEffectiveWidth = input.sidebarVisible
    ? Math.min(requestedSidebarWidth, sidebarOverlay ? overlayWidthLimit : requestedSidebarWidth)
    : 0;
  let panelEffectiveWidth = input.panelVisible
    ? Math.min(requestedPanelWidth, panelOverlay ? overlayWidthLimit : requestedPanelWidth)
    : 0;

  // At the supported compact window sizes both drawers remain inspectable at
  // once instead of one silently covering the other. Preserve the Inspector's
  // requested width and let the navigation drawer yield the overlap first.
  if (
    sidebarOverlay
    && panelOverlay
    && viewportWidth >= MIN_SIDEBAR_OVERLAY_WIDTH + MIN_PANEL_OVERLAY_WIDTH
    && sidebarEffectiveWidth + panelEffectiveWidth > viewportWidth
  ) {
    panelEffectiveWidth = Math.min(panelEffectiveWidth, viewportWidth - MIN_SIDEBAR_OVERLAY_WIDTH);
    sidebarEffectiveWidth = Math.min(sidebarEffectiveWidth, viewportWidth - panelEffectiveWidth);
  }

  const terminalWorkspaceWidth = Math.max(0, viewportWidth - sidebarReservedWidth - panelReservedWidth);

  return {
    sidebarOverlay,
    panelOverlay,
    sidebarEffectiveWidth,
    panelEffectiveWidth,
    sidebarReservedWidth,
    panelReservedWidth,
    terminalWorkspaceWidth,
    minimumTerminalWorkspaceWidth,
  };
}
