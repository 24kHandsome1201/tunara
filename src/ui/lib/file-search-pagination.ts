export type FileSearchMode = "name" | "content";

const NAME_PAGE_SIZE = 80;
const CONTENT_PAGE_SIZE = 200;
const LOCAL_NAME_MAX = 1_000;
const REMOTE_NAME_MAX = 200;
const CONTENT_MAX = 1_000;

export function initialFileSearchLimit(mode: FileSearchMode): number {
  return mode === "content" ? CONTENT_PAGE_SIZE : NAME_PAGE_SIZE;
}

export function maxFileSearchLimit(mode: FileSearchMode, remote: boolean): number {
  if (mode === "content") return CONTENT_MAX;
  return remote ? REMOTE_NAME_MAX : LOCAL_NAME_MAX;
}

export function nextFileSearchLimit(
  current: number,
  mode: FileSearchMode,
  remote: boolean,
): number {
  const pageSize = initialFileSearchLimit(mode);
  return Math.min(maxFileSearchLimit(mode, remote), current + pageSize);
}
