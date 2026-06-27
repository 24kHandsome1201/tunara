import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSessionNoteBlock,
  getSessionNoteStats,
  sanitizeSessionNote,
} from "../src/modules/session/session-notes.ts";

test("session notes normalize line endings and remove unsafe controls", () => {
  assert.equal(sanitizeSessionNote("one\r\ntwo\rthree\u0000"), "one\ntwo\nthree");
  assert.equal(sanitizeSessionNote(42), "");
  assert.equal(sanitizeSessionNote("abcdef", 3), "abc");
});

test("appendSessionNoteBlock inserts one clean gap between note blocks", () => {
  assert.equal(appendSessionNoteBlock("", "## Today\n- plan"), "## Today\n- plan\n");
  assert.equal(
    appendSessionNoteBlock("old note   \n", "  ### Next\n- [ ] test  "),
    "old note\n\n### Next\n- [ ] test\n",
  );
});

test("getSessionNoteStats counts checkboxes without treating plain bullets as tasks", () => {
  const stats = getSessionNoteStats("- [ ] run tests\n- [x] ship\n- plain bullet");
  assert.equal(stats.todoCount, 2);
  assert.equal(stats.doneCount, 1);
  assert.equal(stats.words, 9);
});
