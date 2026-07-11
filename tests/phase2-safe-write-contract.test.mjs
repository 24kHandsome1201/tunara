import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Phase 2 local writes require a fingerprint and expose structured conflicts", () => {
  const backend = read("src-tauri/src/modules/fs/file.rs");
  const bridge = read("src/modules/fs/fs-bridge.ts");
  const runtime = read("src-tauri/src/lib.rs");

  assert.match(backend, /expected_fingerprint: String/);
  assert.match(backend, /WriteResult::Conflict/);
  assert.match(backend, /create_new\(true\)/);
  assert.match(backend, /set_permissions\(original_metadata\.permissions\(\)\)/);
  assert.match(backend, /sync_all\(\)/);
  assert.match(backend, /std::fs::rename\(&temporary_path, &target\)/);
  assert.match(backend, /file_type\(\)\.is_symlink\(\)/);
  assert.match(bridge, /status: "conflict"; currentFingerprint: string/);
  assert.match(bridge, /invoke<WriteTextResult>\("fs_write_text_file"/);
  assert.match(runtime, /fs::file::fs_write_text_file/);
});
