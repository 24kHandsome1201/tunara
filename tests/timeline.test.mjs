import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMELINE_EVENT_LIMIT,
  appendTimelineEvent,
  createTimelineEvent,
  formatTimelineRelativeTime,
  gitChangesFingerprint,
  shouldRecordGitChange,
  trimTimelineDetail,
} from "../src/state/timeline.ts";

test("appendTimelineEvent prepends and caps at the limit", () => {
  const first = createTimelineEvent("command_start", "git status", 1);
  const second = createTimelineEvent("command_end", "git status", 2);
  const merged = appendTimelineEvent([first], second, 1);
  assert.deepEqual(merged, [second]);
});

test("appendTimelineEvent respects the default cap", () => {
  let events = [];
  for (let i = 0; i < TIMELINE_EVENT_LIMIT + 5; i += 1) {
    events = appendTimelineEvent(events, createTimelineEvent("note_saved", String(i), i));
  }
  assert.equal(events.length, TIMELINE_EVENT_LIMIT);
  assert.equal(events[0]?.detail, String(TIMELINE_EVENT_LIMIT + 4));
});

test("trimTimelineDetail collapses whitespace and truncates", () => {
  assert.equal(trimTimelineDetail("  git\nstatus  "), "git status");
  assert.equal(trimTimelineDetail("x".repeat(200)).endsWith("…"), true);
});

test("shouldRecordGitChange compares stable file fingerprints", () => {
  const before = [{ path: "a.ts", status: "M", stage: "unstaged" }];
  const after = [{ path: "a.ts", status: "M", stage: "staged" }];
  assert.equal(gitChangesFingerprint(before), "unstaged:M:a.ts");
  assert.equal(shouldRecordGitChange(before, before), false);
  assert.equal(shouldRecordGitChange(before, after), true);
  assert.equal(shouldRecordGitChange(before, []), true);
});

test("formatTimelineRelativeTime buckets elapsed durations", () => {
  const now = 1_000_000;
  assert.equal(formatTimelineRelativeTime(now - 10_000, now), "now");
  assert.equal(formatTimelineRelativeTime(now - 120_000, now), "2m");
  assert.equal(formatTimelineRelativeTime(now - 7_200_000, now), "2h");
  assert.equal(formatTimelineRelativeTime(now - 172_800_000, now), "2d");
});