import type { AgentEventHeaderV1, AgentEventSource } from "./agent-event-bridge.ts";

export const TIMELINE_PAGE_SIZE = 100;
export const TIMELINE_MAX_RETAINED_HEADERS = 600;
export const TIMELINE_ESTIMATED_ROW_HEIGHT = 62;
export const TIMELINE_OVERSCAN_PX = 280;
export const TIMELINE_BOTTOM_THRESHOLD_PX = 36;

export interface TimelineLayoutRow { id: string; index: number; start: number; size: number; end: number }
export interface TimelineVirtualWindow { rows: TimelineLayoutRow[]; totalSize: number; startIndex: number; endIndex: number }
export interface TimelineAnchor { eventId: string; viewportOffset: number }
export interface TimelineMergeResult { items: AgentEventHeaderV1[]; droppedNewer: number }

function measuredSize(id: string, heights: ReadonlyMap<string, number>, estimate: number): number {
  const value = heights.get(id);
  return value && Number.isFinite(value) && value > 0 ? value : estimate;
}

export function computeTimelineVirtualWindow(ids: readonly string[], heights: ReadonlyMap<string, number>, scrollTop: number, viewportHeight: number, options: { estimate?: number; overscan?: number } = {}): TimelineVirtualWindow {
  const estimate = options.estimate ?? TIMELINE_ESTIMATED_ROW_HEIGHT;
  const overscan = options.overscan ?? TIMELINE_OVERSCAN_PX;
  const starts = new Array<number>(ids.length);
  const sizes = new Array<number>(ids.length);
  let totalSize = 0;
  for (let index = 0; index < ids.length; index += 1) {
    starts[index] = totalSize;
    const size = measuredSize(ids[index], heights, estimate);
    sizes[index] = size;
    totalSize += size;
  }
  const visibleStart = Math.max(0, scrollTop - overscan);
  const visibleEnd = Math.max(visibleStart, scrollTop + Math.max(0, viewportHeight) + overscan);
  let startIndex = 0;
  while (startIndex < ids.length && starts[startIndex] + sizes[startIndex] < visibleStart) startIndex += 1;
  let endIndex = startIndex;
  while (endIndex < ids.length && starts[endIndex] <= visibleEnd) endIndex += 1;
  const rows = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    rows.push({ id: ids[index], index, start: starts[index], size: sizes[index], end: starts[index] + sizes[index] });
  }
  return { rows, totalSize, startIndex, endIndex };
}

export function captureTimelineAnchor(window: TimelineVirtualWindow, scrollTop: number): TimelineAnchor | null {
  const row = window.rows.find((candidate) => candidate.end > scrollTop) ?? window.rows[0];
  return row ? { eventId: row.id, viewportOffset: row.start - scrollTop } : null;
}

export function restoreTimelineAnchor(ids: readonly string[], heights: ReadonlyMap<string, number>, anchor: TimelineAnchor, estimate = TIMELINE_ESTIMATED_ROW_HEIGHT): number | null {
  let top = 0;
  for (const id of ids) {
    if (id === anchor.eventId) return Math.max(0, top - anchor.viewportOffset);
    top += measuredSize(id, heights, estimate);
  }
  return null;
}

export function mergeOlderTimelinePage(existingAscending: readonly AgentEventHeaderV1[], olderNewestFirst: readonly AgentEventHeaderV1[], maxRetained = TIMELINE_MAX_RETAINED_HEADERS): TimelineMergeResult {
  const seen = new Set(existingAscending.map((item) => item.eventId));
  const olderAscending = [...olderNewestFirst].reverse().filter((item) => !seen.has(item.eventId));
  const merged = [...olderAscending, ...existingAscending];
  const droppedNewer = Math.max(0, merged.length - maxRetained);
  return { items: droppedNewer > 0 ? merged.slice(0, maxRetained) : merged, droppedNewer };
}

export function mergeLiveTimelineHeaders(existingAscending: readonly AgentEventHeaderV1[], incoming: readonly AgentEventHeaderV1[], maxRetained = TIMELINE_MAX_RETAINED_HEADERS): AgentEventHeaderV1[] {
  if (incoming.length === 0) return existingAscending as AgentEventHeaderV1[];
  const byId = new Map(existingAscending.map((item) => [item.eventId, item]));
  let changed = false;
  for (const header of incoming) {
    const previous = byId.get(header.eventId);
    if (previous !== header) { byId.set(header.eventId, header); changed = true; }
  }
  if (!changed) return existingAscending as AgentEventHeaderV1[];
  const merged = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  return merged.length > maxRetained ? merged.slice(merged.length - maxRetained) : merged;
}

export function isTimelineAtBottom(scrollTop: number, viewportHeight: number, totalSize: number): boolean {
  return totalSize - (scrollTop + viewportHeight) <= TIMELINE_BOTTOM_THRESHOLD_PX;
}

export type TimelineConfidence = "verified" | "inferred" | "unknown";
export function timelineConfidence(source: AgentEventSource): TimelineConfidence {
  if (source === "hook" || source === "process" || source === "shell_integration" || source === "user") return "verified";
  if (source === "system") return "inferred";
  return "unknown";
}

export function safeTimelineSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 512);
}

export function isCompatibleTimelineHeader(value: unknown): value is AgentEventHeaderV1 {
  if (!value || typeof value !== "object") return false;
  const header = value as Partial<AgentEventHeaderV1>;
  return header.schemaVersion === 1 && Number.isSafeInteger(header.sequence) && typeof header.eventId === "string" && typeof header.clientEventId === "string" && typeof header.workspaceId === "string" && typeof header.taskId === "string" && typeof header.kind === "string" && typeof header.source === "string" && Number.isFinite(header.occurredAtMs) && Number.isFinite(header.recordedAtMs) && typeof header.summary === "string";
}
