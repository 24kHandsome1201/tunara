export type FileSearchMode = "name" | "content";

/** Inputs that define a distinct file-explorer search session. */
export interface FileSearchSessionKey {
  baseDir: string | null;
  searchQuery: string;
  searchMode: FileSearchMode;
  remotePtyId?: number;
}

/**
 * Monotonic generation counter for async file search. Tauri `invoke` has no
 * abort signal, so stale remote/local responses are dropped when the generation
 * no longer matches.
 */
export class FileSearchGeneration {
  private generation = 0;

  /** Start a new search; invalidates any in-flight results from prior calls. */
  start(): number {
    this.generation += 1;
    return this.generation;
  }

  /** Invalidate in-flight searches without starting a new one (effect cleanup). */
  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

/** Stable signature for tests and debugging; not used for equality in the UI. */
export function fileSearchSessionSignature(key: FileSearchSessionKey): string {
  const remote = key.remotePtyId ?? "local";
  const base = key.baseDir ?? "";
  return `${remote}|${base}|${key.searchMode}|${key.searchQuery}`;
}