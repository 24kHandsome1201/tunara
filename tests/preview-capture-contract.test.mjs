import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Preview capture stays in app cache and keeps raw evidence out of tracked surfaces", () => {
  const native = read("src-tauri/src/modules/preview.rs");
  const ignore = read(".gitignore");
  assert.match(native, /app_cache_dir\(\)/);
  assert.match(native, /join\("preview-evidence"\)/);
  assert.match(native, /create_new\(true\)/);
  assert.doesNotMatch(native, /workspace_store|session snapshot|Journal/i);
  assert.match(ignore, /docs\/benchmarks\/raw\/\*\*\/\*\.png/);
  assert.match(ignore, /docs\/benchmarks\/raw\/\*\*\/\*\.jsonl/);
});

test("Preview Send is a source-bound prepare action rather than clipboard delivery or execution", () => {
  const native = read("src-tauri/src/modules/preview.rs");
  assert.match(native, /physical_for_logical\(&source\.session_id\)/);
  assert.match(native, /record\.source_label != label/);
  assert.match(native, /current_generation != Some\(record\.window_generation\)/);
  assert.match(native, /executed: false/);
  assert.doesNotMatch(native, /session\.write\([^)]*\\n/);
});
