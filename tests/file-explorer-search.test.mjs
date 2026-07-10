import assert from "node:assert/strict";
import test from "node:test";

import {
  FileSearchGeneration,
  fileSearchSessionSignature,
} from "../src/ui/lib/file-search-session.ts";
import {
  initialFileSearchLimit,
  maxFileSearchLimit,
  nextFileSearchLimit,
} from "../src/ui/lib/file-search-pagination.ts";

test("FileSearchGeneration drops stale async results after invalidate", () => {
  const gen = new FileSearchGeneration();
  const token = gen.start();
  assert.ok(gen.isCurrent(token));

  gen.invalidate();
  assert.equal(gen.isCurrent(token), false);
});

test("FileSearchGeneration drops stale results when a newer search starts", () => {
  const gen = new FileSearchGeneration();
  const first = gen.start();
  const second = gen.start();

  assert.equal(gen.isCurrent(first), false);
  assert.ok(gen.isCurrent(second));
});

test("fileSearchSessionSignature encodes remote, base, mode, and query", () => {
  assert.equal(
    fileSearchSessionSignature({
      baseDir: "/repo",
      searchQuery: "foo",
      searchMode: "name",
    }),
    "local|/repo|name|foo",
  );
  assert.equal(
    fileSearchSessionSignature({
      baseDir: "/home/user",
      searchQuery: "bar",
      searchMode: "content",
      remotePtyId: 7,
    }),
    "7|/home/user|content|bar",
  );
  assert.equal(
    fileSearchSessionSignature({
      baseDir: null,
      searchQuery: "",
      searchMode: "name",
      remotePtyId: 3,
    }),
    "3||name|",
  );
});

test("file search limits grow by mode-specific pages and stay within backend caps", () => {
  assert.equal(initialFileSearchLimit("name"), 80);
  assert.equal(initialFileSearchLimit("content"), 200);
  assert.equal(maxFileSearchLimit("name", false), 1_000);
  assert.equal(maxFileSearchLimit("name", true), 200);
  assert.equal(maxFileSearchLimit("content", true), 1_000);
  assert.equal(nextFileSearchLimit(80, "name", false), 160);
  assert.equal(nextFileSearchLimit(160, "name", true), 200);
  assert.equal(nextFileSearchLimit(1_000, "content", false), 1_000);
});
