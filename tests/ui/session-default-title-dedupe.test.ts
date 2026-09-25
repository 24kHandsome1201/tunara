import { expect, test } from "vitest";
import { dedupeDefaultTitles } from "@/state/sessions";
import type { Session } from "@/ui/types";

function session(id: string, dir: string, defaultTitleIndex?: number, patch: Partial<Session> = {}): Session {
  return { id, title: "Terminal", dir, branch: "", runState: "idle", updatedAt: 1, defaultTitleIndex, ...patch } as Session;
}

test("restored sessions sharing a default number in one group are renumbered", () => {
  const result = dedupeDefaultTitles([
    session("a", "/home", 1),
    session("b", "/home", 1),
    session("c", "/home", 2),
    session("d", "/other", 1),
    session("e", "/home", 1, { customTitle: "logs" }),
  ]);
  expect(result.map((s) => s.defaultTitleIndex)).toEqual([1, 3, 2, 1, 1]);
  expect(result[1].title).toBe("Terminal 3");
});
