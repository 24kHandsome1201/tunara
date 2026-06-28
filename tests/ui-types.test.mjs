import assert from "node:assert/strict";
import test from "node:test";

import { formatSize, groupByDir } from "../src/ui/types.ts";

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

function session(id, dir) {
  return { id, dir };
}

test("groupByDir buckets sessions by their dir, preserving insertion order", () => {
  const sessions = [
    session("a", "/proj/one"),
    session("b", "/proj/two"),
    session("c", "/proj/one"),
  ];
  const grouped = groupByDir(sessions);
  assert.deepEqual(Object.keys(grouped), ["/proj/one", "/proj/two"]);
  assert.deepEqual(grouped["/proj/one"].map((s) => s.id), ["a", "c"]);
  assert.deepEqual(grouped["/proj/two"].map((s) => s.id), ["b"]);
});

test("groupByDir returns an empty object for an empty session list", () => {
  assert.deepEqual(groupByDir([]), {});
});

test("groupByDir keeps a single-session directory as a one-element array", () => {
  const grouped = groupByDir([session("solo", "/only")]);
  assert.deepEqual(Object.keys(grouped), ["/only"]);
  assert.equal(grouped["/only"].length, 1);
});

test("groupByDir treats prototype-like directory names as plain keys", () => {
  const grouped = groupByDir([
    session("proto", "__proto__"),
    session("constructor", "constructor"),
  ]);

  assert.deepEqual(Object.keys(grouped), ["__proto__", "constructor"]);
  assert.deepEqual(grouped["__proto__"].map((s) => s.id), ["proto"]);
  assert.deepEqual(grouped.constructor.map((s) => s.id), ["constructor"]);
});
