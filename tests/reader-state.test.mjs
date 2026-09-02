import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyReaderState,
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
