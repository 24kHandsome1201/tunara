import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgentCommand,
  detectCodexScreenState,
  isSessionBusy,
  parseAgentLifecycleOsc,
} from "../src/modules/terminal/lib/agent-lifecycle.ts";
import { scanTerminalInputBuffer } from "../src/modules/terminal/lib/terminal-input-buffer.ts";
import {
  CODEX_DATA_BURST_BUSY_THRESHOLD,
  CODEX_STATE_CHECK_DELAY_MS,
  createCodexScreenStateTracker,
} from "../src/modules/terminal/lib/terminal-codex-state.ts";
import { parseOsc7 } from "../src/modules/terminal/lib/osc-handlers.ts";
import {
  findTerminalFileLinkMatches,
  resolveTerminalFileLinkPath,
} from "../src/modules/terminal/lib/terminal-file-link-parser.ts";
import {
  TERMINAL_FONT_LOAD_TIMEOUT_MS,
  buildTerminalFontFamily,
  waitForTerminalFontReady,
} from "../src/modules/terminal/lib/terminal-font.ts";
import { findProgrammingLigatureRanges } from "../src/modules/terminal/lib/terminal-ligatures.ts";
import {
  agentBusyUpdate,
  agentDetectedUpdate,
  agentExitedUpdate,
  agentReadyUpdate,
  commandDetectedUpdate,
  cwdChangedUpdate,
} from "../src/modules/terminal/lib/session-lifecycle.ts";
import { parseKeybinding } from "../src/modules/config/keybindings.ts";
import { collectTerminalBlockOutputText, findStickyCommandBlock } from "../src/ui/useTerminalBlocks.ts";
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

function makeTailTerminal(lines) {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY: lines.length - 1,
        getLine(row) {
          const text = lines[row];
          return text === undefined
            ? undefined
            : { translateToString: () => text };
        },
      },
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

test("sticky command block appears only after scrolling into hidden block output", () => {
  const blocks = [
    { id: "a", command: "pnpm test", startRow: 10, endRow: 80, startedAt: 1, completedAt: 2, exitCode: 0 },
    { id: "b", command: "cargo clippy", startRow: 90, endRow: 160, startedAt: 3 },
  ];

  assert.equal(findStickyCommandBlock(blocks, 10, 40, 200), null);
  assert.equal(findStickyCommandBlock(blocks, 30, 40, 200)?.id, "a");
  assert.equal(findStickyCommandBlock(blocks, 90, 30, 200), null);
  assert.equal(findStickyCommandBlock(blocks, 110, 30, 200)?.id, "b");
  assert.equal(findStickyCommandBlock(blocks, 110, 30, 110), null);
  assert.equal(findStickyCommandBlock(blocks, 170, 30, 200), null);
});

test("terminal block copy output skips the command row", () => {
  const block = { startRow: 0, endRow: 3 };
  assert.equal(
    collectTerminalBlockOutputText(["$ pnpm test", "pass 1", "pass 2", ""], block),
    "pass 1\npass 2",
  );
  assert.equal(collectTerminalBlockOutputText(["$ true"], { startRow: 0, endRow: 0 }), "");
});

test("terminal file links recognize local file positions without treating URLs as files", () => {
  const line = "error TS2322: src/ui/TerminalView.tsx:128:9 - type mismatch";
  const [match] = findTerminalFileLinkMatches(line);
  assert.equal(match.text, "src/ui/TerminalView.tsx:128:9");
  assert.equal(match.rawPath, "src/ui/TerminalView.tsx");
  assert.equal(match.line, 128);
  assert.equal(match.column, 9);
  assert.equal(match.startIndex, line.indexOf("src/ui/TerminalView.tsx"));

  assert.equal(findTerminalFileLinkMatches("see https://example.com/path:12").length, 0);
  assert.equal(findTerminalFileLinkMatches("panic at main.rs:7.")[0].text, "main.rs:7");
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", "/Users/me/repo"), "/Users/me/repo/src/main.rs");
  assert.equal(resolveTerminalFileLinkPath("../lib.rs", "/Users/me/repo"), "/Users/me/lib.rs");
  assert.equal(resolveTerminalFileLinkPath("~/src/app.ts", "/Users/me/repo"), "~/src/app.ts");
});

test("terminal ligature joiner prefers the longest programming sequences", () => {
  assert.deepEqual(findProgrammingLigatureRanges("a !=== b && c -> d"), [
    [2, 6],
    [9, 11],
    [14, 16],
  ]);
  assert.deepEqual(findProgrammingLigatureRanges("plain text"), []);
  assert.deepEqual(findProgrammingLigatureRanges("<!--- block -->"), [
    [0, 5],
    [12, 15],
  ]);
});

test("terminal font loader falls back quickly when font loading stalls", async () => {
  let loadedSpec = "";
  const result = await waitForTerminalFontReady({
    fontSize: 13,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    timeoutMs: 5,
    load: (fontSpec) => {
      loadedSpec = fontSpec;
      return new Promise(() => {});
    },
  });

  assert.equal(result, "timeout");
  assert.equal(
    loadedSpec,
    `13px ${buildTerminalFontFamily("JetBrains Mono", true)}`,
  );
  assert.equal(TERMINAL_FONT_LOAD_TIMEOUT_MS, 200);
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

test("Codex screen tracker names burst and settle policy outside TerminalView", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "idle" });
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createCodexScreenStateTracker({
    terminal: makeTailTerminal(["Codex", "› "]),
    getSessionId: () => "s-1",
    getCurrentSession: () => session,
    isTrackingCodex: () => true,
    onBusy: () => {
      busyCount += 1;
      session = { ...session, agentActivity: "running" };
    },
    onReady: () => {
      readyCount += 1;
      session = { ...session, agentActivity: "idle" };
    },
  });

  for (let i = 1; i < CODEX_DATA_BURST_BUSY_THRESHOLD; i += 1) {
    tracker.schedule();
    assert.equal(busyCount, 0);
  }
  tracker.schedule();
  assert.equal(busyCount, 1);

  await new Promise((resolve) => setTimeout(resolve, CODEX_STATE_CHECK_DELAY_MS + 20));
  assert.equal(readyCount, 1);

  tracker.dispose();
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
