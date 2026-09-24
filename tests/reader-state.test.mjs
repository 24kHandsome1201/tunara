import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeReaderJumpRequest,
  emptyReaderState,
  nextReaderJumpRequestId,
  migrateFileTabsToReaders,
  openReaderFileInState,
  READER_HISTORY_LIMIT,
  readerHistoryBack,
  readerHistoryForward,
  sanitizeSessionReaderState,
} from "../src/modules/session/reader-state.ts";

test("opening a file replaces current, dedupes history, and caps at 10", () => {
  let state = emptyReaderState();
  for (let i = 0; i < 12; i++) {
    state = openReaderFileInState(state, { filePath: `/tmp/${i}.txt`, fileName: `${i}.txt` });
  }
  assert.equal(state.history.length, READER_HISTORY_LIMIT);
  assert.equal(state.current.fileName, "11.txt");
  assert.equal(state.history[0].fileName, "2.txt");

  state = openReaderFileInState(state, { filePath: "/tmp/5.txt", fileName: "5.txt", line: 9 });
  assert.equal(state.current.line, 9);
  assert.equal(state.history.filter((entry) => entry.filePath === "/tmp/5.txt").length, 1);
  assert.equal(state.history.at(-1).filePath, "/tmp/5.txt");
});

test("back and forward walk history without growing it", () => {
  let state = emptyReaderState();
  state = openReaderFileInState(state, { filePath: "/a", fileName: "a" });
  state = openReaderFileInState(state, { filePath: "/b", fileName: "b" });
  state = openReaderFileInState(state, { filePath: "/c", fileName: "c" });
  state = readerHistoryBack(state);
  assert.equal(state.current.fileName, "b");
  state = readerHistoryBack(state);
  assert.equal(state.current.fileName, "a");
  state = readerHistoryForward(state);
  assert.equal(state.current.fileName, "b");
  assert.equal(state.history.length, 3);
});

test("file and staged/unstaged diffs at the same path have distinct history identities", () => {
  let state = emptyReaderState();
  const file = { filePath: "/repo/a.ts", fileName: "a.ts" };
  state = openReaderFileInState(state, file);
  state = openReaderFileInState(state, { ...file, diff: { stage: "staged", repoPath: "/repo", relativePath: "a.ts" } });
  state = openReaderFileInState(state, { ...file, diff: { stage: "unstaged", repoPath: "/repo", relativePath: "a.ts" } });
  assert.equal(state.history.length, 3);
  assert.deepEqual(state.history.map((entry) => entry.diff?.stage ?? "file"), ["file", "staged", "unstaged"]);
});

test("sanitize persists valid diff references and drops malformed ones", () => {
  const valid = sanitizeSessionReaderState({
    current: { filePath: "/repo/a.ts", fileName: "a.ts", diff: { stage: "staged", repoPath: "/repo", relativePath: "a.ts" } },
    history: [],
  });
  assert.deepEqual(valid.current.diff, { stage: "staged", repoPath: "/repo", relativePath: "a.ts" });
  const invalid = sanitizeSessionReaderState({
    current: { filePath: "/repo/a.ts", fileName: "a.ts", diff: { stage: "other", repoPath: "/repo", relativePath: "a.ts" } },
    history: [],
  });
  assert.equal(invalid.current.diff, undefined);
});

test("sanitize drops unsafe keys and restores current from history", () => {
  const state = sanitizeSessionReaderState({
    current: { filePath: "/ok.txt", fileName: "ok.txt" },
    history: [
      { filePath: "/ok.txt", fileName: "ok.txt" },
      { filePath: "bad\npath", fileName: "nope" },
    ],
    historyIndex: 99,
  });
  assert.equal(state.current.fileName, "ok.txt");
  assert.equal(state.history.length, 1);
  assert.equal(state.historyIndex, 0);
});

test("legacy file tabs become one current plus remaining history", () => {
  const readers = migrateFileTabsToReaders([
    { id: "s\0/a.txt", sessionId: "s", filePath: "/a.txt", fileName: "a.txt" },
    { id: "s\0/b.txt", sessionId: "s", filePath: "/b.txt", fileName: "b.txt" },
  ], "s\0/a.txt", new Set(["s"]));
  assert.equal(readers.s.current.fileName, "a.txt");
  assert.deepEqual(readers.s.history.map((entry) => entry.fileName), ["b.txt", "a.txt"]);
});

test("jump requests live only on current and are consumed once", () => {
  const first = nextReaderJumpRequestId();
  let state = openReaderFileInState(emptyReaderState(), { filePath: "/tmp/a.txt", fileName: "a.txt", line: 4, jumpRequestId: first });
  assert.equal(state.current.jumpRequestId, first);
  assert.equal(state.history[0].jumpRequestId, undefined);

  state = openReaderFileInState(state, { filePath: "/tmp/b.txt", fileName: "b.txt" });
  state = readerHistoryBack(state);
  assert.equal(state.current.line, 4);
  assert.equal(state.current.jumpRequestId, undefined, "back/forward must not replay the jump");

  const again = nextReaderJumpRequestId();
  assert.notEqual(again, first);
  state = openReaderFileInState(state, { filePath: "/tmp/a.txt", fileName: "a.txt", line: 4, jumpRequestId: again });
  assert.equal(state.current.jumpRequestId, again, "re-clicking the same hit is a new request");
  assert.equal(sanitizeSessionReaderState(state).current.jumpRequestId, undefined, "never persisted");

  assert.equal(consumeReaderJumpRequest(again), true);
  assert.equal(consumeReaderJumpRequest(again), false);
  assert.equal(consumeReaderJumpRequest(undefined), false);
});
