import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDirectoryTerminalController,
  directoryPickerDefaultPath,
} from "../src/modules/session/new-terminal-directory-controller.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("directory terminal uses the exact selected local path", async () => {
  const created = [];
  const controller = createDirectoryTerminalController({
    pickDirectory: async (defaultPath) => {
      assert.equal(defaultPath, "/Users/example/current");
      return "/Users/example/chosen folder";
    },
    createTerminal: (directory) => created.push(directory),
    onFailure: assert.fail,
  });

  assert.equal(await controller.choose("/Users/example/current"), "created");
  assert.deepEqual(created, ["/Users/example/chosen folder"]);
});

test("directory terminal cancellation has no side effects", async () => {
  let creates = 0;
  const controller = createDirectoryTerminalController({
    pickDirectory: async () => null,
    createTerminal: () => { creates += 1; },
    onFailure: assert.fail,
  });

  assert.equal(await controller.choose(), "cancelled");
  assert.equal(creates, 0);
});

test("directory picker failures do not create a session and surface once", async () => {
  const error = new Error("picker unavailable");
  const failures = [];
  let creates = 0;
  const controller = createDirectoryTerminalController({
    pickDirectory: async () => { throw error; },
    createTerminal: () => { creates += 1; },
    onFailure: (cause) => failures.push(cause),
  });

  assert.equal(await controller.choose(), "failed");
  assert.equal(creates, 0);
  assert.deepEqual(failures, [error]);
});

test("concurrent directory requests share one native picker", async () => {
  let resolvePicker;
  let pickerCalls = 0;
  let creates = 0;
  const controller = createDirectoryTerminalController({
    pickDirectory: () => {
      pickerCalls += 1;
      return new Promise((resolve) => { resolvePicker = resolve; });
    },
    createTerminal: () => { creates += 1; },
    onFailure: assert.fail,
  });

  const first = controller.choose("/Users/example/current");
  const second = controller.choose("/Users/example/other");
  assert.equal(pickerCalls, 1);
  assert.equal(first, second);

  resolvePicker("/Users/example/chosen");
  assert.equal(await first, "created");
  assert.equal(await second, "created");
  assert.equal(creates, 1);
});

test("only absolute local cwd values seed the native picker", () => {
  assert.equal(directoryPickerDefaultPath({ dir: "/Users/example/project" }), "/Users/example/project");
  assert.equal(directoryPickerDefaultPath({ dir: "C:\\Users\\example\\project" }), "C:\\Users\\example\\project");
  assert.equal(directoryPickerDefaultPath({ dir: "\\\\server\\share" }), "\\\\server\\share");
  assert.equal(directoryPickerDefaultPath({ dir: "~" }), undefined);
  assert.equal(directoryPickerDefaultPath({ dir: "relative/project" }), undefined);
  assert.equal(directoryPickerDefaultPath({
    dir: "root@example.com",
    remote: { host: "example.com" },
  }), undefined);
});

test("all directory entry points share the guarded dialog helper", () => {
  const app = read("src/app/App.tsx");
  const sidebar = read("src/ui/SidebarNewTerminalControl.tsx");
  const titlebar = read("src/ui/Titlebar.tsx");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));

  assert.match(app, /openNewTerminalDirectoryDialog/);
  assert.equal((app.match(/onNewTerminalInDirectory=\{newTerminalInDirectory\}/g) ?? []).length, 2);
  assert.match(sidebar, /onClick=\{onNewTerminalInDirectory\}/);
  assert.match(titlebar, /onContextMenu=\{openNewTerminalMenu\}/);
  assert.match(palette, /void openNewTerminalDirectoryDialog\(\)/);
  assert.ok(capability.permissions.includes("dialog:allow-open"));
});
