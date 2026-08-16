import type { DirEntry } from "@/modules/fs/fs-bridge";

export type SortKey = "name" | "modified";
export type SortDirection = "asc" | "desc";

export function joinPath(base: string, name: string): string {
  if (!base || base === "/") return "/" + name;
  return base.endsWith("/") ? base + name : base + "/" + name;
}

export function parentPath(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return trimmed.startsWith("~") ? "~" : "/";
  return trimmed.slice(0, idx);
}

export function compactRelativePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return "…/" + parts.slice(-3).join("/");
}

function compareEntries(a: DirEntry, b: DirEntry, key: SortKey, direction: SortDirection): number {
  const factor = direction === "asc" ? 1 : -1;
  if (key === "modified" && a.mtime !== b.mtime) return (a.mtime - b.mtime) * factor;
  const insensitive = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const nameOrder = insensitive !== 0 ? insensitive : a.name.localeCompare(b.name);
  return key === "modified" ? nameOrder : nameOrder * factor;
}

export function sortExplorerEntries(
  entries: readonly DirEntry[],
  key: SortKey,
  direction: SortDirection,
): DirEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, key, direction));
}

export function formatModifiedTime(mtime: number, now = new Date()): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return "—";
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return "—";
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function nextOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `remote-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
