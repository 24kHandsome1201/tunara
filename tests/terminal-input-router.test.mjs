import test from "node:test";
import assert from "node:assert/strict";
import { TerminalInputRouter, createTerminalLinkInputOwnership, defaultTerminalHostModifier, routeTerminalInput } from "../src/modules/terminal/lib/terminal-input-router.ts";

const input = (kind, overrides = {}) => ({
  kind, mouseTrackingMode: "none", selection: false, pure: false, platform: "linux",
  hostModifier: "shift", modifiers: { shift: false, meta: false, alt: false }, ...overrides,
});

for (const label of ["herdr", "tmux", "vim", "lazygit"]) {
  test(`reporting ownership is generic (${label})`, () => {
    assert.equal(routeTerminalInput(input("mouse-down", { mouseTrackingMode: "any", button: 2 })), "tui");
  });
}

test("right gesture latches its owner through up and contextmenu", () => {
  const router = new TerminalInputRouter();
  assert.equal(router.route(input("mouse-down", { mouseTrackingMode: "any", button: 2 })), "tui");
  assert.equal(router.route(input("mouse-up", { mouseTrackingMode: "none", button: 2 })), "tui");
  assert.equal(router.route(input("contextmenu", { mouseTrackingMode: "none" })), "tui");
  const host = new TerminalInputRouter();
  assert.equal(host.route(input("mouse-down", { mouseTrackingMode: "any", button: 2, modifiers: { shift: true, meta: false, alt: false } })), "tunara");
  assert.equal(host.route(input("contextmenu", { mouseTrackingMode: "any" })), "tunara");

  const webkitOrder = new TerminalInputRouter();
  assert.equal(webkitOrder.route(input("mouse-down", { mouseTrackingMode: "any", button: 2 })), "tui");
  assert.equal(webkitOrder.route(input("contextmenu", { mouseTrackingMode: "none" })), "tui");
  assert.equal(webkitOrder.route(input("mouse-up", { mouseTrackingMode: "none", button: 2, modifiers: { shift: true, meta: false, alt: false } })), "tui");
});

test("platform defaults are Cmd/Meta on macOS and Shift elsewhere", () => {
  assert.equal(defaultTerminalHostModifier("macos"), "meta");
  assert.equal(defaultTerminalHostModifier("windows"), "shift");
  assert.equal(defaultTerminalHostModifier("linux"), "shift");
});

test("links and pointer gestures follow reporting unless host action is requested", () => {
  for (const kind of ["link", "wheel", "drag", "double-click"]) {
    assert.equal(routeTerminalInput(input(kind, { mouseTrackingMode: "vt200" })), "tui");
    assert.equal(routeTerminalInput(input(kind)), "tunara");
    assert.equal(routeTerminalInput(input(kind, { mouseTrackingMode: "vt200", explicitHostAction: true })), "tunara");
  }
});

test("link ownership is latched from down through activation and up", () => {
  let mode = "any";
  const listeners = new Map();
  const element = {
    addEventListener: (kind, listener) => listeners.set(kind, listener),
    removeEventListener: (kind) => listeners.delete(kind),
  };
  const links = createTerminalLinkInputOwnership({
    getMouseTrackingMode: () => mode,
    hasSelection: () => false,
    isPure: () => false,
    getPlatform: () => "linux",
    getHostModifier: () => "shift",
  });
  const dispose = links.attach(element);
  const plainDown = { button: 0, shiftKey: false, metaKey: false, altKey: false, ctrlKey: false, stopPropagation() {} };
  listeners.get("mousedown")(plainDown);
  mode = "none";
  assert.equal(links.shouldActivate(plainDown), false, "reporting owner remains TUI for the click");

  let stopped = 0;
  mode = "any";
  const hostClick = { ...plainDown, shiftKey: true, stopPropagation: () => { stopped += 1; } };
  listeners.get("mousedown")(hostClick);
  assert.equal(links.shouldActivate({ ...plainDown, shiftKey: false }), true, "host owner remains Tunara for activation");
  listeners.get("mouseup")(hostClick);
  assert.equal(stopped, 2, "host-owned down and up are both withheld from xterm");
  dispose();
  assert.equal(listeners.size, 0);
});
