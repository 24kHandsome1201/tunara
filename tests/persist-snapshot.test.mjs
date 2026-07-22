import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createTerminalSnapshotScheduler } from "../src/modules/terminal/lib/terminal-snapshot-scheduler.ts";
import { trimTerminalSnapshotSerialized } from "../src/modules/terminal/lib/terminal-snapshot-trim.ts";
import {
  consumeTerminalSnapshotDirty,
  getTerminalSnapshot,
  markTerminalSnapshotDirty,
  removeTerminalSnapshot,
  updateTerminalSnapshot,
} from "../src/modules/terminal/lib/terminal-snapshot.ts";
import {
  dedupeById,
  fromPersistedSession,
  localSessionDirs,
  sanitizeSnapshot,
  toPersistedSession,
} from "../src/state/persist-snapshot.ts";

function persistedSession(id, dir, updatedAt = 1, extra = {}) {
  return {
    id,
    title: extra.title ?? "终端",
    dir,
    branch: extra.branch ?? "main",
    updatedAt,
    ...extra,
  };
}

function terminalSnapshot(serialized = "buffer", extra = {}) {
  return {
    serialized,
    viewportY: 1,
    baseY: 2,
    cols: 120,
    rows: 40,
    capturedAt: 10,
    truncated: false,
    ...extra,
  };
}

test("persisted session helpers keep only durable fields and restore idle runtime state", () => {
  const session = {
    id: "s-1",
    title: "Terminal",
    dir: "/repo",
    branch: "main",
    runState: "running",
    updatedAt: 10,
    customTitle: " Work ",
    mascot: "fox",
    pinned: true,
    note: "ok\u0000note",
    agent: "CC",
    agentActivity: "running",
    lastCommand: "pnpm test",
    remote: {
      host: " box ",
      port: 22,
      user: " me ",
      identityFile: " ~/.ssh/id_ed25519 ",
      password: "secret",
      keyPassphrase: "secret",
      injectShellIntegration: true,
    },
  };

  const persisted = toPersistedSession(session);
  assert.deepEqual(persisted, {
    id: "s-1",
    title: "Terminal",
    dir: "/repo",
    branch: "main",
    updatedAt: 10,
    customTitle: "Work",
    mascot: "fox",
    pinned: true,
    note: "oknote",
    remote: { host: "box", port: 22, user: "me", identityFile: "~/.ssh/id_ed25519", injectShellIntegration: true },
  });

  const restored = fromPersistedSession(persisted);
  const { connection, ...restoredDurableFields } = restored;
  assert.deepEqual(restoredDurableFields, {
    ...persisted,
    runState: "idle",
  });
  assert.equal(connection.transport, "ssh");
  assert.equal(connection.phase, "pending");
  assert.equal(connection.source, "restore");
});

// Regression: shell-integration injection is default-ON in the backend, so a
// user opting OUT (injectShellIntegration:false) must survive a persist/reopen
// round-trip. An earlier version only persisted `=== true`, which silently
// dropped `false` and re-enabled injection on reopen. See ssh_open's
// unwrap_or(true) — a missing value defaults to inject, so `false` is load-bearing.
test("persisted remote keeps an explicit injectShellIntegration:false (opt-out survives reopen)", () => {
  const optOut = toPersistedSession({
    id: "s-2",
    title: "Terminal",
    dir: "/repo",
    branch: "main",
    updatedAt: 10,
    remote: { host: "box", port: 22, user: "me", injectShellIntegration: false },
  });
  assert.equal(optOut.remote.injectShellIntegration, false, "opt-out must persist as false, not be dropped");

  // And an undefined value (legacy snapshot) is omitted so it falls through to
  // the backend default rather than persisting a spurious boolean.
  const legacy = toPersistedSession({
    id: "s-3",
    title: "Terminal",
    dir: "/repo",
    branch: "main",
    updatedAt: 10,
    remote: { host: "box", port: 22, user: "me" },
  });
  assert.ok(
    !("injectShellIntegration" in legacy.remote),
    "an unset value must not be persisted, so it defaults at reopen",
  );
});

test("snapshot sanitizer clamps layout, drops orphan runtime state, and sanitizes recents", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    const commandUsageEntries = Array.from({ length: 55 }, (_v, i) => [`cmd-${i}`, i]);
    commandUsageEntries.push(["bad", Number.NaN]);
    commandUsageEntries.push(["__proto__", 999]);

    const snapshot = sanitizeSnapshot({
      version: 1,
      savedAt: Number.NaN,
      activeSessionId: "s-active",
      sessions: [
        persistedSession("s-active", "/active", 1, {
          remote: { host: "de-netcup", port: 22, user: "root" },
        }),
        persistedSession("s-a", "/repo-a", 1, { title: "old" }),
        persistedSession("s-a", "/repo-a", 5, { title: "new" }),
        persistedSession("s-b", "/repo-b", 2),
        persistedSession("s-bad", "/repo-bad", 2),
        persistedSession("__proto__", "/polluted", 9),
        { id: "bad", title: "missing fields" },
      ],
      ui: {
        sidebarVisible: false,
        panelVisible: true,
        collapsedDirs: { "/repo-a": true, "/repo-b": false, constructor: true },
        collapsedDiffSections: { staged: true, unstaged: "yes", untracked: true, ["__proto__"]: true },
        split: {
          mode: "vertical",
          paneA: "s-a",
          paneB: "s-b",
          ratio: 0.95,
        },
        // Snapshots written before persistent Agent Timeline was removed must
        // still restore, but the retired tab falls back to Overview.
        inspectorTab: "timeline",
      },
      terminals: {
        "s-a": terminalSnapshot("kept"),
        "s-active": { ...terminalSnapshot("bad-finite"), viewportY: Number.NaN },
        constructor: terminalSnapshot("unsafe-key"),
        orphan: terminalSnapshot("drop"),
        "s-b": { ...terminalSnapshot("bad-size"), cols: Number.POSITIVE_INFINITY },
      },
      agentResume: {
        "s-a": {
          agent: "CC",
          command: "claude --resume abc",
          cwd: "/repo-a",
          provenance: { transport: "local" },
          resumeId: "abc",
          lastSeenAt: 12,
          confidence: "exact",
        },
        "s-active": {
          agent: "PI",
          command: "npx -y @earendil-works/pi-coding-agent@0.79.4 --session pi-id",
          cwd: "/active",
          resumeId: "pi-id",
          lastSeenAt: 12,
          confidence: "exact",
        },
        "s-b": {
          agent: "CX",
          command: "codex",
          cwd: "/repo-b",
          lastSeenAt: 13,
          confidence: "exact",
        },
        "s-bad": {
          agent: "CX",
          command: "codex resume bad",
          cwd: "/repo-bad",
          provenance: { transport: "ssh", host: "", port: 22, user: "root" },
          resumeId: "bad",
          lastSeenAt: 13,
          confidence: "exact",
        },
        orphan: {
          agent: "CC",
          command: "claude",
          cwd: "/orphan",
          lastSeenAt: 14,
          confidence: "unknown",
        },
        constructor: {
          agent: "CC",
          command: "claude",
          cwd: "/polluted",
          lastSeenAt: 15,
          confidence: "unknown",
        },
      },
      recentDirs: ["/repo-a", "", "/repo-a", "/repo-b"],
      recentCommands: ["git status", "bad\ncmd", "git status", "pnpm test"],
      commandUsage: Object.fromEntries(commandUsageEntries),
      workflows: [
        { id: "wf-1", name: " Review ", template: " pnpm test ", description: " Run tests " },
        { id: "bad", name: "", template: "x" },
      ],
    });

    assert.ok(snapshot);
    assert.equal(snapshot.savedAt, 0);
    assert.equal(snapshot.activeSessionId, "s-b");
    assert.deepEqual(snapshot.sessions.map((s) => [s.id, s.title]), [
      ["s-active", "终端"],
      ["s-a", "new"],
      ["s-b", "终端"],
      ["s-bad", "终端"],
    ]);
    assert.deepEqual(snapshot.ui.collapsedDirs, { "/repo-a": true });
    assert.deepEqual(snapshot.ui.collapsedDiffSections, { staged: true, untracked: true });
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot.ui.collapsedDirs, "constructor"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot.ui.collapsedDiffSections, "__proto__"), false);
    assert.deepEqual(snapshot.ui.split, {
      root: {
        type: "split",
        direction: "vertical",
        ratio: 0.8,
        first: { type: "pane", sessionId: "s-a" },
        second: { type: "pane", sessionId: "s-b" },
      },
    });
    assert.equal(snapshot.ui.inspectorTab, "overview");
    assert.deepEqual(Object.keys(snapshot.terminals), ["s-a"]);
    assert.deepEqual(Object.keys(snapshot.agentResume), ["s-a", "s-active", "s-b"]);
    assert.deepEqual(snapshot.agentResume["s-active"].provenance, {
      transport: "ssh",
      host: "de-netcup",
      port: 22,
      user: "root",
    });
    assert.deepEqual(snapshot.agentResume["s-b"].provenance, { transport: "local" });
    assert.deepEqual(snapshot.recentDirs, ["/repo-a", "/repo-b"]);
    assert.deepEqual(snapshot.recentCommands, ["git status", "pnpm test"]);
    assert.equal(Object.keys(snapshot.commandUsage).length, 50);
    assert.deepEqual(Object.keys(snapshot.commandUsage).slice(0, 3), ["cmd-54", "cmd-53", "cmd-52"]);
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot.commandUsage, "__proto__"), false);
    assert.deepEqual(snapshot.workflows, [
      { id: "wf-1", name: "Review", template: " pnpm test ", description: "Run tests" },
    ]);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("snapshot sanitizer restores a four-pane BSP layout and keeps its nested ratios", () => {
  const root = {
    type: "split",
    direction: "horizontal",
    ratio: 0.6,
    first: {
      type: "split",
      direction: "vertical",
      ratio: 0.4,
      first: { type: "pane", sessionId: "top-left" },
      second: { type: "pane", sessionId: "bottom-left" },
    },
    second: {
      type: "split",
      direction: "vertical",
      ratio: 0.7,
      first: { type: "pane", sessionId: "top-right" },
      second: { type: "pane", sessionId: "bottom-right" },
    },
  };
  const snapshot = sanitizeSnapshot({
    version: 1,
    savedAt: 1,
    activeSessionId: "outside",
    sessions: [
      persistedSession("top-left", "/repo/one"),
      persistedSession("bottom-left", "/repo/two"),
      persistedSession("top-right", "/repo/three"),
      persistedSession("bottom-right", "/repo/four"),
      persistedSession("outside", "/repo/outside"),
    ],
    ui: {
      sidebarVisible: true,
      panelVisible: false,
      collapsedDirs: {},
      collapsedDiffSections: {},
      split: { root },
      inspectorTab: "overview",
    },
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.ui.split, { root });
  assert.equal(snapshot.activeSessionId, "bottom-right");
});

test("snapshot sanitizer falls back to local session dirs when recents are absent", () => {
  const snapshot = sanitizeSnapshot({
    version: 1,
    savedAt: 1,
    activeSessionId: "local",
    sessions: [
      persistedSession("local", "/repo", 1),
      persistedSession("remote", "me@box", 2, {
        remote: {
          host: "box",
          port: "22",
          user: "me",
          password: "secret",
          keyPassphrase: "secret",
          acceptUnknownHostKey: true,
        },
      }),
      persistedSession("bad-remote", "bad@box", 3, { remote: { host: "", port: 22, user: "" } }),
      persistedSession("bad-port", "me@bad", 4, { remote: { host: "bad", port: "22oops", user: "me" } }),
      persistedSession("null-remote", "me@null", 5, { remote: null }),
    ],
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.recentDirs, ["/repo"]);
  assert.deepEqual(snapshot.sessions.map((s) => s.id), ["local", "remote"]);
  assert.deepEqual(localSessionDirs(snapshot.sessions), ["/repo"]);
  assert.deepEqual(snapshot.sessions[1].remote, { host: "box", port: 22, user: "me" });
});

test("snapshot sanitizer drops malformed optional session fields without dropping the session", () => {
  const snapshot = sanitizeSnapshot({
    version: 1,
    savedAt: 1,
    activeSessionId: "s-weird",
    sessions: [
      persistedSession("s-weird", "/repo", 1, {
        customTitle: { bad: true },
        mascot: "dragon",
        pinned: "yes",
        note: 123,
      }),
      persistedSession("s-good", "/repo", 2, {
        customTitle: "  Keep me  ",
        mascot: "panda",
        pinned: true,
        note: "ok",
      }),
    ],
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.sessions[0], {
    id: "s-weird",
    title: "终端",
    dir: "/repo",
    branch: "main",
    updatedAt: 1,
  });
  assert.equal(snapshot.sessions[1].customTitle, "Keep me");
  assert.equal(snapshot.sessions[1].mascot, "panda");
  assert.equal(snapshot.sessions[1].pinned, true);
  assert.equal(snapshot.sessions[1].note, "ok");
});

test("snapshot sanitizer bounds terminal snapshot count and serialized size", () => {
  const bigBuffer = "x".repeat(300 * 1024);
  const snapshot = sanitizeSnapshot({
    version: 1,
    savedAt: 1,
    activeSessionId: "s-9",
    sessions: Array.from({ length: 10 }, (_value, i) => persistedSession(`s-${i}`, `/repo-${i}`, i)),
    terminals: Object.fromEntries(
      Array.from({ length: 10 }, (_value, i) => [
        `s-${i}`,
        terminalSnapshot(i === 9 ? bigBuffer : `buffer-${i}`, { capturedAt: i }),
      ]),
    ),
  });

  assert.ok(snapshot);
  assert.deepEqual(Object.keys(snapshot.terminals), ["s-9", "s-8", "s-7", "s-6", "s-5", "s-4", "s-3", "s-2"]);
  assert.equal(snapshot.terminals["s-9"].serialized.length, 256 * 1024);
  assert.equal(snapshot.terminals["s-9"].truncated, true);
  assert.equal(snapshot.terminals["s-1"], undefined);
});

test("terminal snapshot trimming preserves UTF-16 and ANSI boundaries", () => {
  assert.equal(trimTerminalSnapshotSerialized("A😀tail", 5), "tail");
  assert.equal(trimTerminalSnapshotSerialized("prefix\u001b[31mRED", 6), "RED");
  assert.equal(
    trimTerminalSnapshotSerialized("prefix\u001b]8;;https://example.test\u001b\\label", 12),
    "label",
  );
  assert.equal(trimTerminalSnapshotSerialized("plain", 5), "plain");
});

test("terminal snapshot scheduler drops queued captures after the session is removed", async () => {
  const sessionId = `removed-${Date.now()}`;
  const term = {
    buffer: { active: { viewportY: 3, baseY: 4 } },
    cols: 120,
    rows: 40,
  };
  const scheduler = createTerminalSnapshotScheduler({
    term,
    serializeAddon: { serialize: () => "stale scrollback" },
    sessionId: () => sessionId,
    isActive: () => true,
    shouldCapture: () => false,
  });

  try {
    scheduler.schedule();
    await delay(1_100);
    assert.equal(getTerminalSnapshot(sessionId), undefined);
  } finally {
    scheduler.dispose();
    removeTerminalSnapshot(sessionId);
  }
});

test("terminal snapshot scheduler flushes terminal-only writes without waiting for output debounce", () => {
  const sessionId = `exit-flush-${Date.now()}`;
  let serialized = "before exit";
  const term = {
    buffer: { active: { viewportY: 5, baseY: 9 } },
    cols: 100,
    rows: 30,
  };
  const scheduler = createTerminalSnapshotScheduler({
    term,
    serializeAddon: { serialize: () => serialized },
    sessionId: () => sessionId,
    isActive: () => true,
  });

  try {
    scheduler.flush();
    assert.equal(getTerminalSnapshot(sessionId).serialized, "before exit");

    serialized = "before exit\r\n[process exited: 0]";
    scheduler.flush();
    const snapshot = getTerminalSnapshot(sessionId);
    assert.equal(snapshot.serialized, "before exit\r\n[process exited: 0]");
    assert.equal(snapshot.viewportY, 5);
    assert.equal(snapshot.baseY, 9);
  } finally {
    scheduler.dispose();
    removeTerminalSnapshot(sessionId);
  }
});

test("terminal snapshot dirty flag can be restored after a failed persist attempt", () => {
  const sessionId = `dirty-retry-${Date.now()}`;
  consumeTerminalSnapshotDirty();
  try {
    updateTerminalSnapshot(sessionId, terminalSnapshot("retry"));
    assert.equal(consumeTerminalSnapshotDirty(), true);
    assert.equal(consumeTerminalSnapshotDirty(), false);

    markTerminalSnapshotDirty();
    assert.equal(consumeTerminalSnapshotDirty(), true);
  } finally {
    removeTerminalSnapshot(sessionId);
    consumeTerminalSnapshotDirty();
  }
});

test("dedupeById keeps first-seen order while retaining the newest record", () => {
  assert.deepEqual(dedupeById([
    { id: "b", updatedAt: 1, value: "old-b" },
    { id: "a", updatedAt: 3, value: "a" },
    { id: "b", updatedAt: 4, value: "new-b" },
  ]), [
    { id: "b", updatedAt: 4, value: "new-b" },
    { id: "a", updatedAt: 3, value: "a" },
  ]);
});
