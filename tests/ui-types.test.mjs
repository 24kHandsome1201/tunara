import assert from "node:assert/strict";
import test from "node:test";

import { formatSize } from "../src/ui/types.ts";

test("formatSize reports bytes below 1 KiB", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1), "1 B");
  assert.equal(formatSize(1023), "1023 B");
});

test("formatSize switches to KB at the 1024-byte boundary", () => {
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(1024 * 1024 - 1), "1024.0 KB");
});

test("formatSize switches to MB at the 1 MiB boundary", () => {
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(5 * 1024 * 1024 + 512 * 1024), "5.5 MB");
});
