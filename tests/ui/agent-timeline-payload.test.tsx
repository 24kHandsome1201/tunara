import { expect, test } from "vitest";
import { budgetTimelineText, TIMELINE_RICH_MAX_DOM_ROWS, TIMELINE_RICH_MAX_LINES, TIMELINE_RICH_MAX_TEXT_BYTES, tokenizeTimelineCode } from "@/ui/agent-timeline-rich-renderer";
import { TimelinePayloadFault, TimelinePayloadResourceManager, TIMELINE_PAYLOAD_CACHE_MAX_BYTES, TIMELINE_PAYLOAD_CACHE_MAX_ENTRIES, type TimelinePayloadContentType } from "@/modules/agent-events/payload-resource";
import type { AgentEventHeaderV1, AgentEventPayload } from "@/modules/agent-events/agent-event-bridge";
import { parseMarkdownDocument } from "@/modules/editor/markdown-reader";

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fixtureHeader(index: number, contentType: TimelinePayloadContentType, body: string): Promise<AgentEventHeaderV1> {
  return {
    schemaVersion: 1,
    sequence: index + 1,
    eventId: `event-${index + 1}`,
    clientEventId: `client-${index + 1}`,
    workspaceId: "workspace-fixture",
    taskId: "task-fixture",
    sessionId: "task-fixture",
    kind: contentType === "text/x-diff" ? "file_change" : contentType.startsWith("image/") ? "preview_evidence" : "tool_call",
    source: "hook",
    occurredAtMs: 1_700_000_000_000 + index,
    recordedAtMs: 1_700_000_000_000 + index,
    summary: `fixture ${index}`,
    payload: { state: "available", contentType, byteLength: new TextEncoder().encode(body).byteLength, sha256: await sha256(body) },
  };
}

test("1,000 Markdown code blocks stay inside text, line and DOM budgets", () => {
  const source = Array.from({ length: 1_000 }, (_, index) => `## block ${index}\n\n\`\`\`ts\nconst value${index} = ${index}\n\`\`\``).join("\n\n");
  const budget = budgetTimelineText(source);
  const parsed = parseMarkdownDocument(budget.text);
  expect(new TextEncoder().encode(budget.text).byteLength).toBeLessThanOrEqual(TIMELINE_RICH_MAX_TEXT_BYTES);
  expect(budget.text.split("\n").length).toBeLessThanOrEqual(TIMELINE_RICH_MAX_LINES);
  expect(parsed.blocks.slice(0, TIMELINE_RICH_MAX_DOM_ROWS).length).toBeLessThanOrEqual(TIMELINE_RICH_MAX_DOM_ROWS);
  expect(budget.truncated).toBe(true);
  expect(tokenizeTimelineCode("const result = await run(42) // safe").map((token) => token.kind)).toContain("keyword");
});

test("500 tool calls, 200 diffs and 100 local images only read requested payloads", async () => {
  const bodies: Record<TimelinePayloadContentType, string> = {
    "text/plain": "tool output\n".repeat(32),
    "text/markdown": "```ts\nconst safe = true\n```",
    "application/json": "{\"passed\":true}",
    "text/x-diff": "@@ -1 +1 @@\n-old\n+new",
    "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "image/jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==",
    "image/webp": "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v3AgAA=",
  };
  const specs: TimelinePayloadContentType[] = [
    ...Array<TimelinePayloadContentType>(1_000).fill("text/markdown"),
    ...Array<TimelinePayloadContentType>(500).fill("text/plain"),
    ...Array<TimelinePayloadContentType>(200).fill("text/x-diff"),
    ...Array<TimelinePayloadContentType>(100).fill("image/png"),
  ];
  const headers = await Promise.all(specs.map((type, index) => fixtureHeader(index, type, bodies[type])));
  let reads = 0;
  const loader = async (eventId: string): Promise<AgentEventPayload> => {
    reads += 1;
    const header = headers[Number(eventId.slice(6)) - 1];
    const body = bodies[header.payload!.contentType as TimelinePayloadContentType];
    return { eventId, contentType: header.payload!.contentType, body, byteLength: header.payload!.byteLength, sha256: header.payload!.sha256 };
  };
  const manager = new TimelinePayloadResourceManager(loader);
  expect(reads).toBe(0);
  const requested = [0, 211, 999, 1_000, 1_499, 1_500, 1_699, 1_700, 1_750, 1_799];
  await Promise.all(requested.map((index) => manager.request(headers[index], { signal: new AbortController().signal, provenanceKnown: true })));
  expect(reads).toBe(requested.length);
  expect(manager.snapshot().peakActive).toBeLessThanOrEqual(4);
  expect(manager.snapshot().cacheEntries).toBeLessThanOrEqual(TIMELINE_PAYLOAD_CACHE_MAX_ENTRIES);
  expect(manager.snapshot().cacheBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_CACHE_MAX_BYTES);
  expect(headers.length - reads).toBe(1_790);
  manager.dispose();
});

test("rapid row recycling bounds the queue and discards stale results", async () => {
  const body = "deferred private payload";
  const headers = await Promise.all(Array.from({ length: 80 }, (_, index) => fixtureHeader(index, "text/plain", body)));
  const resolvers = new Map<string, (payload: AgentEventPayload) => void>();
  const loader = (eventId: string) => new Promise<AgentEventPayload>((resolve) => resolvers.set(eventId, resolve));
  const manager = new TimelinePayloadResourceManager(loader);
  const controllers = headers.map(() => new AbortController());
  const pending = headers.map((header, index) => manager.request(header, { signal: controllers[index].signal, provenanceKnown: true }).catch((reason) => reason));
  controllers.forEach((controller) => controller.abort());
  for (const [eventId, resolve] of resolvers) {
    const header = headers[Number(eventId.slice(6)) - 1];
    resolve({ eventId, contentType: "text/plain", body, byteLength: header.payload!.byteLength, sha256: header.payload!.sha256 });
  }
  const results = await Promise.all(pending);
  expect(results.every((result) => result instanceof TimelinePayloadFault)).toBe(true);
  expect(manager.snapshot().peakActive).toBeLessThanOrEqual(4);
  expect(manager.snapshot().queued).toBe(0);
  expect(manager.snapshot().cacheEntries).toBe(0);
  manager.dispose();
});

test("corrupt metadata, unknown provenance and payload mismatches fail closed", async () => {
  const body = "private";
  const header = await fixtureHeader(0, "text/plain", body);
  const manager = new TimelinePayloadResourceManager(async (eventId) => ({ eventId, contentType: "text/plain", body: "tampered", byteLength: 8, sha256: header.payload!.sha256 }));
  await expect(manager.request(header, { signal: new AbortController().signal, provenanceKnown: false })).rejects.toMatchObject({ code: "provenanceUnknown" });
  await expect(manager.request(header, { signal: new AbortController().signal, provenanceKnown: true })).rejects.toMatchObject({ code: "sizeMismatch" });
  await expect(manager.request({ ...header, payload: { ...header.payload!, contentType: "text/html" } }, { signal: new AbortController().signal, provenanceKnown: true })).rejects.toMatchObject({ code: "metadataInvalid" });
  manager.dispose();
});

test("a fresh consumer never attaches to an already aborted in-flight read", async () => {
  const body = "race-safe payload";
  const header = await fixtureHeader(0, "text/plain", body);
  const resolvers: Array<(payload: AgentEventPayload) => void> = [];
  const manager = new TimelinePayloadResourceManager(() => new Promise<AgentEventPayload>((resolve) => resolvers.push(resolve)));
  const first = new AbortController();
  const firstResult = manager.request(header, { signal: first.signal, provenanceKnown: true }).catch((reason) => reason);
  first.abort();
  const second = new AbortController();
  const secondResult = manager.request(header, { signal: second.signal, provenanceKnown: true });
  await Promise.resolve();
  expect(resolvers).toHaveLength(2);
  const payload = { eventId: header.eventId, contentType: "text/plain", body, byteLength: header.payload!.byteLength, sha256: header.payload!.sha256 };
  resolvers[0](payload);
  resolvers[1](payload);
  expect(await firstResult).toBeInstanceOf(TimelinePayloadFault);
  expect((await secondResult).body).toBe(body);
  expect(manager.snapshot().readsCompleted).toBe(1);
  manager.dispose();
});

test("an explicit expansion displaces the oldest queued viewport read", async () => {
  const body = "priority payload";
  const headers = await Promise.all(Array.from({ length: 3 }, (_, index) => fixtureHeader(index, "text/plain", body)));
  const resolvers = new Map<string, (payload: AgentEventPayload) => void>();
  const manager = new TimelinePayloadResourceManager(
    (eventId) => new Promise<AgentEventPayload>((resolve) => resolvers.set(eventId, resolve)),
    { maxBytes: 1024, maxEntries: 3, maxConcurrent: 1, maxQueued: 1 },
  );
  const normal = new AbortController();
  const active = manager.request(headers[0], { signal: normal.signal, provenanceKnown: true });
  const displaced = manager.request(headers[1], { signal: normal.signal, provenanceKnown: true }).catch((reason) => reason);
  const explicit = manager.request(headers[2], { signal: normal.signal, provenanceKnown: true, priority: true });
  expect(await displaced).toMatchObject({ code: "requestBudgetExceeded" });
  const makePayload = (header: AgentEventHeaderV1): AgentEventPayload => ({ eventId: header.eventId, contentType: "text/plain", body, byteLength: header.payload!.byteLength, sha256: header.payload!.sha256 });
  resolvers.get(headers[0].eventId)!(makePayload(headers[0]));
  await active;
  await Promise.resolve();
  resolvers.get(headers[2].eventId)!(makePayload(headers[2]));
  expect((await explicit).eventId).toBe(headers[2].eventId);
  expect(manager.snapshot().readsStarted).toBe(2);
  manager.dispose();
});
