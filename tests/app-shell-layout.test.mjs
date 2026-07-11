import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_SINGLE_TERMINAL_WIDTH,
  MIN_PANEL_OVERLAY_WIDTH,
  MIN_SIDEBAR_OVERLAY_WIDTH,
  MIN_TERMINAL_PANE_WIDTH,
  SPLIT_HANDLE_WIDTH,
  auxiliarySurfaceToCloseOnOpen,
  resolveAppShellLayout,
} from "../src/app/lib/app-shell-layout.ts";

const defaults = {
  sidebarVisible: true,
  panelVisible: true,
  sidebarWidth: 272,
  panelWidth: 320,
};

test("compact app shell overlays both auxiliaries without shrinking the terminal", () => {
  for (const viewportWidth of [576, 640, 719]) {
    const layout = resolveAppShellLayout({ ...defaults, viewportWidth, splitMode: "horizontal" });
    assert.equal(layout.sidebarOverlay, true);
    assert.equal(layout.panelOverlay, true);
    assert.equal(layout.terminalWorkspaceWidth, MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH);
    assert.ok(layout.sidebarEffectiveWidth + layout.panelEffectiveWidth <= viewportWidth);
  }
});

test("dock decisions use terminal budget instead of discontinuous viewport breakpoints", () => {
  for (const viewportWidth of [899, 900]) {
    const layout = resolveAppShellLayout({ ...defaults, viewportWidth, splitMode: "horizontal" });
    assert.equal(layout.sidebarOverlay, false);
    assert.equal(layout.panelOverlay, true);
    assert.equal(layout.terminalWorkspaceWidth, MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH);
    assert.ok(layout.terminalWorkspaceWidth >= MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH);
  }

  const before = resolveAppShellLayout({ ...defaults, viewportWidth: 899, splitMode: "horizontal" });
  const after = resolveAppShellLayout({ ...defaults, viewportWidth: 900, splitMode: "horizontal" });
  assert.ok(after.terminalWorkspaceWidth >= before.terminalWorkspaceWidth);
});

test("Inspector yields before the sidebar when requested widths would crush a split", () => {
  const layout = resolveAppShellLayout({
    ...defaults,
    viewportWidth: 1200,
    sidebarWidth: 400,
    panelWidth: 540,
    splitMode: "horizontal",
  });
  assert.equal(layout.sidebarOverlay, false);
  assert.equal(layout.panelOverlay, true);
  assert.equal(layout.terminalWorkspaceWidth, MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH);
});

test("terminal width never falls when a panel changes from overlay to docked", () => {
  for (const [splitMode, boundary] of [["single", 1072], ["horizontal", 1157]]) {
    const widths = [boundary - 2, boundary - 1, boundary, boundary + 1, boundary + 2]
      .map((viewportWidth) => resolveAppShellLayout({ ...defaults, viewportWidth, splitMode }).terminalWorkspaceWidth);
    for (let i = 1; i < widths.length; i += 1) {
      assert.ok(widths[i] >= widths[i - 1], `${splitMode} terminal width regressed at ${boundary}`);
    }
  }
});

test("single and vertical terminals use one-pane horizontal budget", () => {
  for (const splitMode of ["single", "vertical"]) {
    const layout = resolveAppShellLayout({ ...defaults, viewportWidth: 1000, splitMode });
    assert.equal(layout.minimumTerminalWorkspaceWidth, MIN_SINGLE_TERMINAL_WIDTH);
    assert.equal(layout.panelOverlay, true);
    assert.ok(layout.terminalWorkspaceWidth >= MIN_SINGLE_TERMINAL_WIDTH);
  }
});

test("hidden auxiliaries consume no width and overlay widths stay inside tiny viewports", () => {
  const hidden = resolveAppShellLayout({
    ...defaults,
    viewportWidth: 640,
    sidebarVisible: false,
    panelVisible: false,
    splitMode: "single",
  });
  assert.equal(hidden.sidebarEffectiveWidth, 0);
  assert.equal(hidden.panelEffectiveWidth, 0);
  assert.equal(hidden.terminalWorkspaceWidth, 640);

  const restoredWideWidths = resolveAppShellLayout({
    ...defaults,
    viewportWidth: 640,
    sidebarWidth: 400,
    panelWidth: 540,
    splitMode: "horizontal",
  });
  assert.equal(restoredWideWidths.sidebarEffectiveWidth, MIN_SIDEBAR_OVERLAY_WIDTH);
  assert.equal(restoredWideWidths.panelEffectiveWidth, 640 - MIN_SIDEBAR_OVERLAY_WIDTH);
  assert.ok(restoredWideWidths.panelEffectiveWidth >= MIN_PANEL_OVERLAY_WIDTH);
  assert.equal(restoredWideWidths.terminalWorkspaceWidth, MIN_TERMINAL_PANE_WIDTH * 2 + SPLIT_HANDLE_WIDTH);

  for (const splitMode of ["single", "vertical"]) {
    const onePane = resolveAppShellLayout({
      ...defaults,
      viewportWidth: 640,
      sidebarWidth: 400,
      panelWidth: 540,
      splitMode,
    });
    assert.equal(onePane.sidebarEffectiveWidth, MIN_SIDEBAR_OVERLAY_WIDTH);
    assert.equal(onePane.panelEffectiveWidth, 640 - MIN_SIDEBAR_OVERLAY_WIDTH);
    assert.equal(onePane.terminalWorkspaceWidth, MIN_SINGLE_TERMINAL_WIDTH);
  }
});

test("opening a compact drawer closes its overlapping sibling", () => {
  const compact = { ...defaults, viewportWidth: 640, splitMode: "horizontal" };
  assert.equal(auxiliarySurfaceToCloseOnOpen({ ...compact, sidebarVisible: false }, "sidebar"), "panel");
  assert.equal(auxiliarySurfaceToCloseOnOpen({ ...compact, panelVisible: false }, "panel"), "sidebar");

  const wide = { ...defaults, viewportWidth: 1280, splitMode: "single" };
  assert.equal(auxiliarySurfaceToCloseOnOpen({ ...wide, sidebarVisible: false }, "sidebar"), null);
  assert.equal(auxiliarySurfaceToCloseOnOpen({ ...wide, panelVisible: false }, "panel"), null);
});
