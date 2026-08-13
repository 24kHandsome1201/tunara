import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Linux window override keeps the complete default and resize contract", () => {
  const base = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows[0];
  const linux = JSON.parse(read("src-tauri/tauri.linux.conf.json")).app.windows[0];

  // Platform config arrays replace the base array, so these fields must be
  // repeated rather than assumed to merge into the base window descriptor.
  for (const key of ["width", "height", "minWidth", "minHeight", "resizable", "visible"]) {
    assert.equal(linux[key], base[key], `${key} drifted from the base window contract`);
  }
  assert.equal(linux.label, "main");
  assert.equal(linux.decorations, false);
  assert.equal(linux.transparent, true);
});

test("borderless Linux chrome exposes native resize dragging on every edge", () => {
  const app = read("src/app/App.tsx");
  const main = read("src/main.tsx");
  const styles = read("src/styles/globals.css");
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));

  for (const direction of ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"]) {
    assert.match(app, new RegExp(`\\["${direction}",`));
  }
  assert.match(app, /win\.startResizeDragging\(direction\)/);
  assert.match(app, /document\.documentElement\.dataset\.chrome !== "borderless"/);
  assert.match(main, /navigator\.userAgent\.includes\("Linux"\) && "__TAURI_INTERNALS__" in window/);
  assert.match(styles, /\.window-resize-handle[\s\S]*z-index: 10000/);
  assert.match(styles, /\.window-resize-n[\s\S]*\.window-resize-nw/);
  assert.ok(capability.permissions.includes("core:window:allow-start-resize-dragging"));
});

test("native window state only restores size and position", () => {
  const lib = read("src-tauri/src/lib.rs");

  assert.match(lib, /StateFlags::SIZE[\s\S]*StateFlags::POSITION/);
  assert.doesNotMatch(lib, /StateFlags::MAXIMIZED|StateFlags::DECORATIONS|StateFlags::FULLSCREEN/);
});
