import assert from "node:assert/strict";
import test from "node:test";

// Regression guard for the "text garbles after the terminal sits idle, fixed
// by resizing" bug. Root cause: the WebGL renderer bakes glyphs into a texture
// atlas that goes stale (idle GPU reclaim, font/theme swap, ligature toggle),
// and nothing rebuilt it short of a resize. The fix funnels every invalidation
// path through WebglAddon.clearTextureAtlas(). These tests pin the contract
// that the invalidation paths actually invoke their rebuild callback, so a
// future refactor that drops the call fails here instead of in production.

test("resize observer rebuilds the WebGL atlas after fitting", async () => {
  const ResizeObserverStub = class {
    constructor(cb) { ResizeObserverStub.lastCb = cb; }
    observe() {}
    disconnect() {}
  };
  const prevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ResizeObserverStub;
  try {
    const { observeTerminalResize } = await import(
      "../src/modules/terminal/lib/terminal-resize.ts"
    );

    let rebuilds = 0;
    let fits = 0;
    // Start at 80x24, then report a new size so the debounced fit path runs.
    const element = { clientWidth: 80, clientHeight: 24 };
    const terminal = { cols: 100, rows: 30 };
    const fit = { fit: () => { fits += 1; } };

    const dispose = observeTerminalResize({
      element,
      terminal,
      fit,
      resizePty: () => {},
      isDisposed: () => false,
      rebuildAtlas: () => { rebuilds += 1; },
    });

    // Simulate a real size change, then fire the observer callback.
    element.clientWidth = 120;
    element.clientHeight = 40;
    ResizeObserverStub.lastCb();

    // The fit path is debounced by 8ms; wait it out.
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(fits, 1, "fit() ran for the size change");
    assert.equal(
      rebuilds,
      1,
      "atlas was rebuilt after fit — this is what made 'resize fixes garble' work",
    );
    dispose();
  } finally {
    if (prevRO) globalThis.ResizeObserver = prevRO;
    else delete globalThis.ResizeObserver;
  }
});

test("atlas refresh rebuilds on visibility regain and window focus", async () => {
  const listeners = { doc: new Map(), win: new Map() };
  const makeTarget = (bucket) => ({
    addEventListener: (type, fn) => { bucket.set(type, fn); },
    removeEventListener: (type) => { bucket.delete(type); },
  });
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  globalThis.document = { ...makeTarget(listeners.doc), visibilityState: "visible" };
  globalThis.window = makeTarget(listeners.win);
  try {
    const { registerTerminalAtlasRefresh } = await import(
      "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
    );

    let rebuilds = 0;
    const dispose = registerTerminalAtlasRefresh(() => { rebuilds += 1; });

    // Window focus regained → rebuild.
    listeners.win.get("focus")();
    assert.equal(rebuilds, 1, "rebuilt on window focus");

    // Tab became visible again → rebuild.
    globalThis.document.visibilityState = "visible";
    listeners.doc.get("visibilitychange")();
    assert.equal(rebuilds, 2, "rebuilt when document became visible");

    // Tab went hidden → must NOT rebuild (would thrash a backgrounded tab).
    globalThis.document.visibilityState = "hidden";
    listeners.doc.get("visibilitychange")();
    assert.equal(rebuilds, 2, "no rebuild while hidden");

    // After dispose, listeners are gone.
    dispose();
    assert.equal(listeners.doc.size, 0, "document listener removed");
    assert.equal(listeners.win.size, 0, "window listener removed");
  } finally {
    if (prevDoc) globalThis.document = prevDoc; else delete globalThis.document;
    if (prevWin) globalThis.window = prevWin; else delete globalThis.window;
  }
});

test("resize observer skips the rebuild when size is unchanged (no churn)", async () => {
  const ResizeObserverStub = class {
    constructor(cb) { ResizeObserverStub.lastCb = cb; }
    observe() {}
    disconnect() {}
  };
  const prevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = ResizeObserverStub;
  try {
    const { observeTerminalResize } = await import(
      "../src/modules/terminal/lib/terminal-resize.ts"
    );

    let rebuilds = 0;
    const element = { clientWidth: 80, clientHeight: 24 };
    const dispose = observeTerminalResize({
      element,
      terminal: { cols: 80, rows: 24 },
      fit: { fit: () => {} },
      resizePty: () => {},
      isDisposed: () => false,
      rebuildAtlas: () => { rebuilds += 1; },
    });

    // No size change between construction and the callback.
    ResizeObserverStub.lastCb();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(rebuilds, 0, "no rebuild when the cell grid did not change");
    dispose();
  } finally {
    if (prevRO) globalThis.ResizeObserver = prevRO;
    else delete globalThis.ResizeObserver;
  }
});
