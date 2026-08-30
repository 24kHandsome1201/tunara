import { describe, expect, test } from "vitest";

import { useSessionsStore } from "@/state/sessions";
import type { Session } from "@/ui/types";

function session(id: string, dir = "/repo"): Session {
  return {
    id,
    title: "Terminal",
    dir,
    branch: "main",
    runState: "idle",
    updatedAt: 1,
  };
}

describe("workspace persistence revision", () => {
  test("ignores 10k runtime updates and bumps exactly once for each changed persisted field", () => {
    useSessionsStore.setState({
      sessions: [session("one"), session("two", "/other")],
      activeSessionId: "one",
      workspacePersistenceRevision: 0,
      recentDirs: [],
      recentCommands: [],
      hostFilePrefs: {},
    });
    let scheduledSaves = 0;
    let previousRevision = 0;
    const unsubscribe = useSessionsStore.subscribe((state) => {
      if (state.workspacePersistenceRevision === previousRevision) return;
      previousRevision = state.workspacePersistenceRevision;
      scheduledSaves += 1;
    });

    try {
      for (let index = 0; index < 10_000; index += 1) {
        useSessionsStore.getState().updateSession("one", {
          runState: index % 2 === 0 ? "running" : "idle",
          terminalProgress: { state: "normal", value: index % 101, updatedAt: index },
          connection: {
            transport: "local",
            phase: index % 2 === 0 ? "ready" : "opening",
            source: "renderer",
            updatedAt: index,
          },
          gitState: index % 2 === 0 ? "repo" : "unknown",
          changes: {
            files: [{
              path: `runtime-${index}.txt`,
              status: "modified",
              stage: "unstaged",
              added: index,
              removed: 0,
            }],
          },
          ptyId: index,
          transportGeneration: `runtime-${index}`,
        });
      }
      expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(0);
      expect(scheduledSaves).toBe(0);

      useSessionsStore.getState().updateSession("one", { branch: "main" });
      useSessionsStore.getState().updateSession("one", { updatedAt: 999 });
      expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(0);

      const patches: Partial<Session>[] = [
        { title: "Build" },
        { dir: "/repo-next" },
        { branch: "feature" },
        { customTitle: "Review" },
        { remote: { host: "box", port: 22, user: "alice" } },
        { pinned: true },
        {
          agentResume: {
            agent: "CC",
            command: "claude --resume abc",
            cwd: "/repo-next",
            provenance: { transport: "local" },
            resumeId: "abc",
            lastSeenAt: 10,
            confidence: "exact",
          },
        },
      ];
      patches.forEach((patch, index) => {
        useSessionsStore.getState().updateSession("one", patch);
        expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(index + 1);
      });
      expect(scheduledSaves).toBe(patches.length);

      useSessionsStore.getState().updateSession("one", {
        remote: { user: "alice", port: 22, host: "box" },
      });
      expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(patches.length);

      useSessionsStore.getState().setActive("two");
      expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(patches.length + 1);
      useSessionsStore.getState().setActive("two");
      expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(patches.length + 1);
    } finally {
      unsubscribe();
    }
  });

  test("persisted recents and host preferences ignore identical updates", () => {
    useSessionsStore.setState({
      sessions: [session("one")],
      activeSessionId: "one",
      workspacePersistenceRevision: 0,
      recentDirs: [],
      recentCommands: [],
      hostFilePrefs: {},
    });
    const store = useSessionsStore.getState();

    store.recordRecentDir("/repo");
    store.recordRecentDir("/repo");
    store.recordRecentCommand("pnpm test");
    store.recordRecentCommand("pnpm test");
    store.patchHostFilePrefs("alice@box:22", (prefs) => prefs);
    store.patchHostFilePrefs("alice@box:22", (prefs) => prefs);

    expect(useSessionsStore.getState().workspacePersistenceRevision).toBe(3);
  });
});
