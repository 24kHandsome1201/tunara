import assert from "node:assert/strict";
import test from "node:test";
import { TIMELINE_MAX_RETAINED_HEADERS, captureTimelineAnchor, computeTimelineVirtualWindow, isCompatibleTimelineHeader, isTimelineAtBottom, mergeLiveTimelineHeaders, mergeOlderTimelinePage, restoreTimelineAnchor, timelineConfidence } from "../src/modules/agent-events/timeline-model.ts";

function header(sequence, taskId = "task-a", overrides = {}) {
  return { schemaVersion: 1, sequence, eventId: `event-${sequence}`, clientEventId: `client-${sequence}`, workspaceId: "workspace-fixture", taskId, sessionId: taskId, kind: sequence % 11 === 0 ? "test_result" : "output_summary", source: sequence % 7 === 0 ? "heuristic" : "hook", occurredAtMs: 1_700_000_000_000 + sequence, recordedAtMs: 1_700_000_000_000 + sequence, summary: `fixture event ${sequence} 中文`, ...overrides };
}

test("10,000 deterministic headers retain a bounded frontend window", () => {
  let retained = [];
  for (let newest = 10_000; newest > 0; newest -= 100) {
    const page = Array.from({ length: Math.min(100, newest) }, (_, index) => header(newest - index));
    retained = mergeOlderTimelinePage(retained, page).items;
    assert.ok(retained.length <= TIMELINE_MAX_RETAINED_HEADERS);
  }
  assert.equal(retained.length, TIMELINE_MAX_RETAINED_HEADERS);
  assert.equal(retained[0].sequence, 1);
  assert.equal(retained.at(-1).sequence, TIMELINE_MAX_RETAINED_HEADERS);
});

test("dynamic virtual window renders bounded viewport rows", () => {
  const ids = Array.from({ length: 10_000 }, (_, index) => `event-${index + 1}`);
  const heights = new Map(ids.slice(0, 400).map((id, index) => [id, 38 + index % 5 * 11]));
  const window = computeTimelineVirtualWindow(ids, heights, 281_337, 433);
  assert.ok(window.rows.length > 0 && window.rows.length < 30, `rendered ${window.rows.length} rows`);
  assert.ok(window.totalSize > 500_000);
});

test("prepend restores the same event and pixel anchor", () => {
  const existing = Array.from({ length: 100 }, (_, index) => header(index + 101));
  const heights = new Map(existing.map((item, index) => [item.eventId, 44 + index % 4 * 7]));
  const before = computeTimelineVirtualWindow(existing.map((item) => item.eventId), heights, 1_234, 480);
  const anchor = captureTimelineAnchor(before, 1_234);
  assert.ok(anchor);
  const older = Array.from({ length: 100 }, (_, index) => header(100 - index));
  const merged = mergeOlderTimelinePage(existing, older).items;
  const restored = restoreTimelineAnchor(merged.map((item) => item.eventId), heights, anchor);
  assert.ok(restored > 1_234);
  assert.equal(captureTimelineAnchor(computeTimelineVirtualWindow(merged.map((item) => item.eventId), heights, restored, 480), restored)?.eventId, anchor.eventId);
});

test("one high-rate streaming event updates in place without replacing history", () => {
  const history = Array.from({ length: 80 }, (_, index) => header(index + 1));
  const stable = history[20];
  let current = history;
  for (let frame = 0; frame < 1_000; frame += 1) current = mergeLiveTimelineHeaders(current, [header(81, "task-a", { eventId: "streaming-event", clientEventId: "streaming-client", summary: `stream chunk ${frame}` })]);
  assert.equal(current.length, 81);
  assert.equal(current[20], stable);
  assert.equal(current.at(-1).summary, "stream chunk 999");
});

test("multi-task pages stay isolated and append does not disturb bottom semantics", () => {
  const taskA = Array.from({ length: 50 }, (_, index) => header(index + 1, "task-a"));
  const taskB = Array.from({ length: 50 }, (_, index) => header(index + 1, "task-b"));
  assert.equal(taskB.length, 50);
  assert.equal(mergeLiveTimelineHeaders(taskA, [header(51, "task-a")]).length, 51);
  assert.equal(isTimelineAtBottom(3_600, 433, 4_020), true);
  assert.equal(isTimelineAtBottom(2_200, 433, 4_020), false);
});

test("old or missing fields fail closed and confidence reflects provenance", () => {
  assert.equal(isCompatibleTimelineHeader(header(1)), true);
  assert.equal(isCompatibleTimelineHeader({ ...header(1), schemaVersion: 0 }), false);
  assert.equal(isCompatibleTimelineHeader({ ...header(1), summary: undefined }), false);
  assert.equal(timelineConfidence("hook"), "verified");
  assert.equal(timelineConfidence("system"), "inferred");
  assert.equal(timelineConfidence("heuristic"), "unknown");
});
