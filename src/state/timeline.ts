export const TIMELINE_EVENT_LIMIT = 200;

export type TimelineEventType =
  | "command_start"
  | "command_end"
  | "agent_start"
  | "agent_stop"
  | "connection_ready"
  | "connection_failed"
  | "connection_lost"
  | "git_change"
  | "note_saved";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  at: number;
  detail?: string;
}

export function createTimelineEvent(
  type: TimelineEventType,
  detail?: string,
  now = Date.now(),
): TimelineEvent {
  return {
    id: `tl-${now}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    at: now,
    ...(detail ? { detail: trimTimelineDetail(detail) } : {}),
  };
}

export function appendTimelineEvent(
  events: TimelineEvent[],
  event: TimelineEvent,
  limit = TIMELINE_EVENT_LIMIT,
): TimelineEvent[] {
  return [event, ...events].slice(0, limit);
}

export function trimTimelineDetail(detail: string, max = 160): string {
  const normalized = detail.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function gitChangesFingerprint(
  files: readonly { path: string; status?: string; stage?: string }[] | undefined,
): string {
  if (!files || files.length === 0) return "";
  return files
    .map((file) => `${file.stage ?? ""}:${file.status ?? ""}:${file.path}`)
    .sort()
    .join("|");
}

export function shouldRecordGitChange(
  previous: readonly { path: string; status?: string; stage?: string }[] | undefined,
  next: readonly { path: string; status?: string; stage?: string }[] | undefined,
): boolean {
  return gitChangesFingerprint(previous) !== gitChangesFingerprint(next);
}

export function formatTimelineRelativeTime(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
