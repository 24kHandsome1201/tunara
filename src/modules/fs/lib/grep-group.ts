import type { GrepHit } from "../fs-bridge.ts";

export interface GrepFileGroup {
  rel: string;
  path: string;
  lines: { line: number; text: string }[];
}

/**
 * Group flat grep hits by file, preserving first-seen file order and the
 * per-file line order from the input (the backend searcher emits lines in
 * ascending order within a file, so this keeps that ordering).
 *
 * Pure: only a type-only import (erased by --experimental-strip-types), no
 * `@/` value imports, no window, no invoke — safe for the Node test runner.
 */
export function groupGrepHitsByFile(hits: GrepHit[]): GrepFileGroup[] {
  const map = new Map<string, GrepFileGroup>();
  for (const hit of hits) {
    let group = map.get(hit.path);
    if (!group) {
      group = { rel: hit.rel, path: hit.path, lines: [] };
      map.set(hit.path, group);
    }
    group.lines.push({ line: hit.line, text: hit.text });
  }
  return Array.from(map.values());
}
