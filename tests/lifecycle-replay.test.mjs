import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgentCommand,
  detectCodexScreenState,
  isSessionBusy,
  parseAgentLifecycleOsc,
} from "../src/modules/terminal/lib/agent-lifecycle.ts";
import { scanTerminalInputBuffer } from "../src/modules/terminal/lib/terminal-input-buffer.ts";
import { parseOsc7 } from "../src/modules/terminal/lib/osc-handlers.ts";
import {
  agentBusyUpdate,
  agentDetectedUpdate,
  agentExitedUpdate,
  agentReadyUpdate,
  commandDetectedUpdate,
  cwdChangedUpdate,
} from "../src/modules/terminal/lib/session-lifecycle.ts";
import { parseKeybinding } from "../src/modules/config/keybindings.ts";
import { deriveTitle } from "../src/ui/types.ts";

function makeSession(overrides = {}) {
  return {
    id: "s-1",
    title: "终端",
    dir: "/repo",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ...overrides,
  };
}

function createHarness(initial = makeSession()) {
  let session = initial;
  let gitRefreshes = 0;

  const apply = (update) => {
    if (!update) return false;
    session = { ...session, ...update.patch, updatedAt: session.updatedAt + 1 };
    if (update.refreshGit) gitRefreshes += 1;
    return true;
  };

  const applyAgentOsc = (data, now = 100) => {
    const payload = parseAgentLifecycleOsc(data);
    assert.ok(payload, `expected valid lifecycle OSC: ${data}`);
    if (payload.session !== session.id) return false;

    if (payload.event === "start") {
      return apply(agentDetectedUpdate(session, payload.agent, now));
    }
    if (!session.agent || session.agent !== payload.agent) return false;
    if (payload.event === "exit") {
      return apply(agentExitedUpdate(session, payload.code ?? 0, true, now));
    }
    if (payload.event === "idle" || payload.event === "stop") {
      return apply(agentReadyUpdate(session, true, now));
    }
    return false;
  };

  return {
    apply,
    applyAgentOsc,
    get session() {
      return session;
    },
    get gitRefreshes() {
      return gitRefreshes;
    },
  };
}

test("terminal input buffer scans submissions across chunks", () => {
  let result = scanTerminalInputBuffer("", "cla");
  assert.equal(result.buffer, "cla");
  assert.deepEqual(result.submissions, []);

  result = scanTerminalInputBuffer(result.buffer, "ude\r");
  assert.equal(result.buffer, "");
  assert.deepEqual(result.submissions, ["claude"]);
});

test("terminal input buffer handles editing keys and terminal escape noise", () => {
  assert.deepEqual(scanTerminalInputBuffer("", "abc\x7fd\n"), {
    buffer: "",
    submissions: ["abd"],
  });
  assert.deepEqual(scanTerminalInputBuffer("", "abc\x15d\n"), {
    buffer: "",
    submissions: ["d"],
  });
  assert.deepEqual(scanTerminalInputBuffer("", "ab\x1b[Acd\n"), {
    buffer: "",
    submissions: ["abcd"],
  });
  assert.deepEqual(scanTerminalInputBuffer("", "ab\x1b]0;title\x07cd\n"), {
    buffer: "",
    submissions: ["abcd"],
  });
  assert.deepEqual(scanTerminalInputBuffer("", "one\ntwo\r"), {
    buffer: "",
    submissions: ["one", "two"],
  });
});

test("agent command detection maps first shell command token only", () => {
  assert.equal(detectAgentCommand("claude --dangerously-skip-permissions"), "CC");
  assert.equal(detectAgentCommand("\x1b[32mcodex\x1b[0m exec"), "CX");
  assert.equal(detectAgentCommand("ampcode"), "AM");
  assert.equal(detectAgentCommand("cursor-agent run task"), "CR");
  assert.equal(detectAgentCommand("agent run task"), null);
  assert.equal(detectAgentCommand("copilot suggest"), "CP");
  assert.equal(detectAgentCommand("ls claude"), null);
  assert.equal(detectAgentCommand(""), null);
});

test("keybinding parser accepts plus as a literal key", () => {
  assert.deepEqual(parseKeybinding("Mod++"), {
    key: "+",
    mod: true,
    shift: false,
    alt: false,
    ctrl: false,
    meta: false,
  });
  assert.deepEqual(parseKeybinding("Mod+Plus"), {
    key: "+",
    mod: true,
    shift: false,
    alt: false,
    ctrl: false,
    meta: false,
  });
});

test("Claude lifecycle replay clears sidebar busy state and restores terminal title on exit", () => {
  const h = createHarness();

  assert.equal(h.applyAgentOsc("conduit-agent;start;s-1;CC;", 10), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "starting");
  assert.equal(deriveTitle(h.session).primary, "Claude Code");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(h.applyAgentOsc("conduit-agent;idle;s-1;CC;", 20), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(isSessionBusy(h.session), false);

  assert.equal(h.apply(agentBusyUpdate(h.session, 30)), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(h.applyAgentOsc("conduit-agent;exit;s-1;CC;0", 40), true);
  assert.equal(h.session.agent, undefined);
  assert.equal(h.session.agentActivity, undefined);
  assert.equal(h.session.title, "终端");
  assert.equal(deriveTitle(h.session).primary, "终端");
  assert.equal(isSessionBusy(h.session), false);
  assert.equal(h.session.lastExitCode, 0);
  assert.equal(h.gitRefreshes, 2);
});

test("lifecycle events for another session are ignored", () => {
  const h = createHarness();

  assert.equal(h.applyAgentOsc("conduit-agent;start;s-2;CC;", 10), false);
  assert.equal(h.session.agent, undefined);
  assert.equal(deriveTitle(h.session).primary, "终端");
  assert.equal(isSessionBusy(h.session), false);
});

test("Codex screen replay moves between busy and idle without real Codex", () => {
  const h = createHarness();

  assert.equal(h.apply(agentDetectedUpdate(h.session, "CX", 10)), true);
  assert.equal(h.session.agent, "CX");
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(isSessionBusy(h.session), false);

  assert.equal(detectCodexScreenState("Codex\nWorking\nesc to interrupt"), "busy");
  assert.equal(h.apply(agentBusyUpdate(h.session, 20)), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(detectCodexScreenState("Codex\n\n› "), "ready");
  assert.equal(h.apply(agentReadyUpdate(h.session, true, 30)), true);
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(isSessionBusy(h.session), false);
});

test("OSC 7 cwd replay updates sidebar directory and clears stale git context", () => {
  const h = createHarness(makeSession({
    branch: "main",
    changes: {
      summary: "1 file changed",
      files: [{ path: "old.ts", status: "modified", added: 1, removed: 0 }],
    },
    lastCommand: "cd /tmp/project a",
    shellTitle: "old-title",
    suppressShellTitle: true,
  }));

  const cwd = parseOsc7("file://localhost/tmp/project%20a");
  assert.equal(cwd, "/tmp/project a");
  assert.equal(h.apply(cwdChangedUpdate(h.session, cwd)), true);

  assert.equal(h.session.dir, "/tmp/project a");
  assert.equal(h.session.branch, "");
  assert.equal(h.session.changes, undefined);
  assert.equal(h.session.lastCommand, undefined);
  assert.equal(h.session.shellTitle, undefined);
  assert.equal(h.session.suppressShellTitle, false);
  assert.equal(h.gitRefreshes, 1);
});

test("ordinary commands do not replace an active agent identity", () => {
  const h = createHarness(makeSession({
    agent: "CC",
    agentActivity: "idle",
    title: "Claude Code",
  }));

  assert.equal(h.apply(commandDetectedUpdate(h.session, "claude explain this", 10)), false);
  assert.equal(h.session.agent, "CC");
  assert.equal(deriveTitle(h.session).primary, "Claude Code");
});
