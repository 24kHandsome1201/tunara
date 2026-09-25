import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalSearchSnippet,
  compileTerminalSearch,
  createLatestSearchRunner,
  groupTerminalSearchMatches,
  searchTerminalSources,
  stringOffsetToCellColumn,
} from "../src/modules/terminal/lib/cross-session-search.ts";

function source(sessionId, lines, blocks) {
  return { sessionId, lineCount: lines.length, readLine: (row) => lines[row], blocks };
}

const immediate = () => Promise.resolve();

test("compileTerminalSearch supports plain, case-sensitive and regex modes", () => {
  const plain = compileTerminalSearch("error", { regex: false, caseSensitive: false });
  assert.ok(plain.ok);
  assert.deepEqual(plain.find("Build ERROR here"), { start: 6, end: 11 });
  const cased = compileTerminalSearch("error", { regex: false, caseSensitive: true });
  assert.ok(cased.ok);
  assert.equal(cased.find("Build ERROR here"), null);
  const regex = compileTerminalSearch("exit \\d+", { regex: true, caseSensitive: false });
  assert.ok(regex.ok);
  assert.deepEqual(regex.find("process EXIT 127"), { start: 8, end: 16 });
  assert.equal(regex.find("process exit"), null);
});

test("compileTerminalSearch rejects empty queries and invalid regex, skips zero-width matches", () => {
  assert.deepEqual(compileTerminalSearch("", { regex: false, caseSensitive: false }), { ok: false, reason: "empty" });
  assert.deepEqual(compileTerminalSearch("(", { regex: true, caseSensitive: false }), { ok: false, reason: "invalid-regex" });
  const zeroWidth = compileTerminalSearch("^|b", { regex: true, caseSensitive: false });
  assert.ok(zeroWidth.ok);
  assert.deepEqual(zeroWidth.find("abc"), { start: 1, end: 2 });
  const onlyZeroWidth = compileTerminalSearch("^", { regex: true, caseSensitive: false });
  assert.ok(onlyZeroWidth.ok);
  assert.equal(onlyZeroWidth.find("abc"), null);
  // Stateful /g regex is reset per line.
  const repeat = compileTerminalSearch("a", { regex: true, caseSensitive: true });
  assert.ok(repeat.ok);
  assert.deepEqual(repeat.find("xa"), { start: 1, end: 2 });
  assert.deepEqual(repeat.find("a"), { start: 0, end: 1 });
});

test("searchTerminalSources scans every session newest-row-first and caps results", async () => {
  const compiled = compileTerminalSearch("hit", { regex: false, caseSensitive: false });
  assert.ok(compiled.ok);
  const sources = [
    source("a", ["hit 0", "miss", "hit 2"]),
    source("b", ["hit 0", "hit 1", "hit 2", "hit 3"]),
  ];
  const all = await searchTerminalSources(sources, compiled.find, { yieldToHost: immediate });
  assert.equal(all.done, true);
  assert.equal(all.cancelled, false);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.matches.map((m) => `${m.sessionId}:${m.row}`), ["a:2", "a:0", "b:3", "b:2", "b:1", "b:0"]);
  assert.equal(all.scannedLines, 7);

  const perSession = await searchTerminalSources(sources, compiled.find, { yieldToHost: immediate, maxResultsPerSession: 2 });
  assert.deepEqual(perSession.matches.map((m) => `${m.sessionId}:${m.row}`), ["a:2", "a:0", "b:3", "b:2"]);
  assert.equal(perSession.truncated, true);

  const global = await searchTerminalSources(sources, compiled.find, { yieldToHost: immediate, maxResults: 3 });
  assert.deepEqual(global.matches.map((m) => `${m.sessionId}:${m.row}`), ["a:2", "a:0", "b:3"]);
  assert.equal(global.truncated, true);
});

test("searchTerminalSources yields in slices and stops when superseded", async () => {
  const compiled = compileTerminalSearch("x", { regex: false, caseSensitive: false });
  assert.ok(compiled.ok);
  const lines = Array.from({ length: 5_000 }, (_, i) => (i % 10 === 0 ? "x marks" : "plain"));
  let clock = 0;
  let yields = 0;
  const runner = createLatestSearchRunner();
  const run = runner.begin();
  const progress = [];
  const outcome = await searchTerminalSources([source("s", lines)], compiled.find, {
    now: () => (clock += 1),
    sliceBudgetMs: 1,
    yieldToHost: async () => {
      yields += 1;
      if (yields === 2) runner.begin();
    },
    isCancelled: run.isCancelled,
    onProgress: (snapshot) => progress.push(snapshot),
  });
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.done, false);
  assert.equal(yields, 2);
  assert.ok(outcome.scannedLines < lines.length);
  assert.ok(progress.length >= 1);
  assert.ok(progress.every((snapshot) => !snapshot.done));
});

test("createLatestSearchRunner cancels every earlier run", () => {
  const runner = createLatestSearchRunner();
  const first = runner.begin();
  const second = runner.begin();
  assert.equal(first.isCancelled(), true);
  assert.equal(second.isCancelled(), false);
  runner.cancel();
  assert.equal(second.isCancelled(), true);
});

test("groupTerminalSearchMatches groups by source order and attaches command blocks", () => {
  const blocks = [
    { command: "  pnpm   test ", startRow: 0, endRow: 4 },
    { command: "git status", startRow: 5, endRow: 8 },
  ];
  const groups = groupTerminalSearchMatches(
    [
      { sessionId: "b", row: 1, start: 0, end: 1, text: "b" },
      { sessionId: "a", row: 6, start: 0, end: 1, text: "a6" },
      { sessionId: "a", row: 2, start: 0, end: 1, text: "a2" },
      { sessionId: "a", row: 20, start: 0, end: 1, text: "a20" },
    ],
    [{ sessionId: "a", blocks }, { sessionId: "b" }],
  );
  assert.deepEqual(groups.map((g) => g.sessionId), ["a", "b"]);
  assert.deepEqual(groups[0].matches.map((m) => [m.row, m.command]), [[6, "git status"], [2, "pnpm test"], [20, null]]);
  assert.equal(groups[1].matches[0].command, null);
});

test("buildTerminalSearchSnippet trims around the match", () => {
  const text = `${"a".repeat(100)}NEEDLE${"b".repeat(100)}`;
  const snippet = buildTerminalSearchSnippet(text, { start: 100, end: 106 }, 5);
  assert.deepEqual(snippet, { before: "…aaaaa", match: "NEEDLE", after: "bbbbb…" });
  assert.deepEqual(buildTerminalSearchSnippet("  ok done", { start: 2, end: 4 }), { before: "", match: "ok", after: " done" });
});

test("stringOffsetToCellColumn accounts for wide glyphs", () => {
  // "中x" occupies cells [中][spacer][x]
  const cells = [{ chars: "中", width: 2 }, { chars: "", width: 0 }, { chars: "x", width: 1 }];
  const getCell = (column) => cells[column];
  assert.equal(stringOffsetToCellColumn(3, getCell, 0), 0);
  assert.equal(stringOffsetToCellColumn(3, getCell, 1), 2);
  assert.equal(stringOffsetToCellColumn(3, getCell, 2), 3);
});

test("10 sessions × 10k lines produce first results well under 100 ms", async () => {
  const compiled = compileTerminalSearch("needle", { regex: false, caseSensitive: false });
  assert.ok(compiled.ok);
  const sources = Array.from({ length: 10 }, (_, s) => {
    const lines = Array.from({ length: 10_000 }, (_, i) =>
      i % 997 === 0 ? `line ${i} with a needle inside session ${s}` : `ordinary output line ${i} of session ${s} ${"-".repeat(40)}`);
    return source(`s${s}`, lines);
  });
  const started = performance.now();
  let firstAt = null;
  const outcome = await searchTerminalSources(sources, compiled.find, {
    onProgress: (snapshot) => {
      if (firstAt === null && snapshot.matches.length > 0) firstAt = performance.now() - started;
    },
  });
  assert.equal(outcome.done, true);
  assert.equal(outcome.scannedLines, 100_000);
  assert.equal(outcome.matches.length, 110);
  assert.ok(firstAt !== null && firstAt < 100, `first results took ${firstAt} ms`);
});
