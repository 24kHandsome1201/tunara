import { beforeEach, describe, expect, test } from "vitest";

import { groupSessionsForSidebar, sidebarGroupKey } from "@/modules/session/sidebar-groups";
import { useSessionsStore } from "@/state/sessions";
import type { Session } from "@/ui/types";

function session(id: string, dir: string): Session {
  return { id, title: id, dir, branch: "main", runState: "idle", updatedAt: 1 };
}

function sidebarLayout() {
  return groupSessionsForSidebar(useSessionsStore.getState().sessions).map((group) => ({
    key: group.key,
    ids: group.sessions.map((s) => s.id),
  }));
}

function reorder(dir: string, fromIndex: number, toIndex: number) {
  useSessionsStore.getState().reorderInGroup(sidebarGroupKey({ dir }), fromIndex, toIndex);
}

beforeEach(() => {
  useSessionsStore.setState({
    sessions: [session("a1", "/alpha"), session("b1", "/beta"), session("a2", "/alpha"), session("b2", "/beta")],
    workspacePersistenceRevision: 0,
  });
});

describe("reorderInGroup", () => {
  test("moving the first session of a group down keeps project groups in place", () => {
    reorder("/alpha", 0, 1);

    expect(sidebarLayout()).toEqual([
      { key: "local:/alpha", ids: ["a2", "a1"] },
      { key: "local:/beta", ids: ["b1", "b2"] },
    ]);
    expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(1);
  });

  test("moving a session up to the top of a later group keeps project groups in place", () => {
    reorder("/beta", 1, 0);

    expect(sidebarLayout()).toEqual([
      { key: "local:/alpha", ids: ["a1", "a2"] },
      { key: "local:/beta", ids: ["b2", "b1"] },
    ]);
  });

  test("only the sessions of the reordered group change slots", () => {
    useSessionsStore.setState({
      sessions: [session("a1", "/alpha"), session("b1", "/beta"), session("a2", "/alpha"), session("a3", "/alpha")],
    });

    reorder("/alpha", 0, 2);

    expect(useSessionsStore.getState().sessions.map((s) => s.id)).toEqual(["a2", "b1", "a3", "a1"]);
  });

  test("ignores no-op and out-of-range moves", () => {
    const before = useSessionsStore.getState().sessions;
    reorder("/alpha", 1, 1);
    reorder("/alpha", 0, 2);
    reorder("/alpha", -1, 0);

    expect(useSessionsStore.getState().sessions).toBe(before);
    expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(0);
  });
});
