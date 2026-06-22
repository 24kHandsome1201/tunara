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
  createTerminalHyperlinkHandler,
  normalizeTerminalHyperlink,
} from "../src/modules/terminal/lib/terminal-hyperlinks.ts";
import {
  collectTerminalQuickSelectItems,
  findTerminalQuickSelectTextTokens,
  findTerminalUrlTokens,
  quickSelectHint,
} from "../src/modules/terminal/lib/terminal-quick-select.ts";
import {
  TERMINAL_LARGE_PASTE_WARNING_LENGTH,
  analyzeTerminalPaste,
  confirmProtectedTerminalPaste,
  terminalPasteWarningMessage,
} from "../src/modules/terminal/lib/terminal-paste-protection.ts";
import {
  TERMINAL_QUICK_SELECT_SCOPE_LINES,
  terminalQuickSelectRange,
} from "../src/modules/terminal/lib/terminal-quick-select-scope.ts";
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
import { collectTerminalBlockOutputText, findNavigableCommandBlock, findStickyCommandBlock, formatTerminalBlockCommandAndOutput, normalizeBlockCommand } from "../src/ui/useTerminalBlocks.ts";
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

test("terminal block command copy source is normalized without truncation", () => {
  const longArg = "x".repeat(100);
  const command = `pnpm   exec\n  vitest ${longArg}`;
  assert.equal(normalizeBlockCommand(command), `pnpm exec vitest ${longArg}`);
  assert.equal(normalizeBlockCommand(command).includes("..."), false);
});

test("terminal block combined copy keeps command before output", () => {
  assert.equal(
    formatTerminalBlockCommandAndOutput("pnpm test", "pass 1\npass 2"),
    "pnpm test\npass 1\npass 2",
  );
  assert.equal(formatTerminalBlockCommandAndOutput("true", ""), "true");
});

test("terminal command block navigation follows prompt marks around the viewport", () => {
  const blocks = [
    { id: "a", command: "pnpm test", startRow: 10, endRow: 30, startedAt: 1, completedAt: 2, exitCode: 0 },
    { id: "b", command: "cargo clippy", startRow: 80, endRow: 120, startedAt: 3, completedAt: 4, exitCode: 0 },
    { id: "c", command: "pnpm build", startRow: 160, endRow: 190, startedAt: 5 },
  ];

  assert.equal(findNavigableCommandBlock(blocks, 100, "previous")?.id, "b");
  assert.equal(findNavigableCommandBlock(blocks, 80, "previous")?.id, "a");
  assert.equal(findNavigableCommandBlock(blocks, 100, "next")?.id, "c");
  assert.equal(findNavigableCommandBlock(blocks, 160, "next"), null);
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

test("terminal OSC 8 hyperlink handler opens only HTTP URLs", () => {
  assert.equal(normalizeTerminalHyperlink("https://example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeTerminalHyperlink("http://example.com/a b"), "http://example.com/a%20b");
  assert.equal(normalizeTerminalHyperlink("javascript:alert(1)"), null);
  assert.equal(normalizeTerminalHyperlink("file:///tmp/secrets.txt"), null);
  assert.equal(normalizeTerminalHyperlink("not a url"), null);

  const opened = [];
  const events = [];
  const handler = createTerminalHyperlinkHandler((url) => opened.push(url));
  const event = {
    preventDefault: () => events.push("prevent"),
    stopPropagation: () => events.push("stop"),
  };
  const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
  handler.activate(event, "https://example.com/linked", range);
  handler.activate(event, "ssh://example.com", range);

  assert.equal(handler.allowNonHttpProtocols, false);
  assert.deepEqual(opened, ["https://example.com/linked"]);
  assert.deepEqual(events, ["prevent", "stop", "prevent", "stop"]);
});

test("terminal paste protection guards multiline and large pastes", () => {
  assert.equal(analyzeTerminalPaste("echo ok"), null);
  assert.deepEqual(analyzeTerminalPaste("echo one\necho two"), {
    charCount: 17,
    lineCount: 2,
    large: false,
    multiline: true,
  });
  assert.equal(analyzeTerminalPaste("x".repeat(TERMINAL_LARGE_PASTE_WARNING_LENGTH))?.large, undefined);
  assert.equal(analyzeTerminalPaste("x".repeat(TERMINAL_LARGE_PASTE_WARNING_LENGTH + 1))?.large, true);

  const warning = analyzeTerminalPaste("echo one\necho two");
  assert.ok(warning);
  assert.match(terminalPasteWarningMessage(warning), /2 行/);

  const pasted = [];
  const prompts = [];
  assert.equal(confirmProtectedTerminalPaste("echo ok", () => true, (text) => pasted.push(text)), false);
  assert.equal(confirmProtectedTerminalPaste("echo one\necho two", (message) => {
    prompts.push(message);
    return false;
  }, (text) => pasted.push(text)), true);
  assert.deepEqual(pasted, []);
  assert.equal(prompts.length, 1);

  assert.equal(confirmProtectedTerminalPaste("echo one\necho two", () => true, (text) => pasted.push(text)), true);
  assert.deepEqual(pasted, ["echo one\necho two"]);
});

test("terminal quick select extracts visible URLs, file positions, and copy tokens", () => {
  const items = collectTerminalQuickSelectItems([
    "open https://example.com/docs.",
    "error TS2322: src/ui/TerminalView.tsx:128:9 - type mismatch",
    "commit 7ec8346468c6ec404df5e0e1ed16648bee660839 reached 192.168.1.12 with exit code 42",
    "repeat https://example.com/docs",
  ], "/Users/me/repo");

  assert.equal(items.length, 5);
  assert.equal(items[0].kind, "url");
  assert.equal(items[0].target, "https://example.com/docs");
  assert.equal(items[0].copyText, "https://example.com/docs");
  assert.equal(items[0].detail, "example.com");
  assert.equal(items[1].kind, "file");
  assert.equal(items[1].label, "src/ui/TerminalView.tsx:128:9");
  assert.equal(items[1].copyText, "src/ui/TerminalView.tsx:128:9");
  assert.equal(items[1].target, "/Users/me/repo/src/ui/TerminalView.tsx");
  assert.equal(items[1].line, 128);
  assert.equal(items[1].column, 9);
  assert.deepEqual(items.slice(2).map((item) => [item.kind, item.detail, item.copyText]), [
    ["text", "Git hash", "7ec8346468c6ec404df5e0e1ed16648bee660839"],
    ["text", "IP address", "192.168.1.12"],
    ["text", "Number", "42"],
  ]);
  assert.deepEqual(findTerminalUrlTokens("see http://a.test/x, and https://b.test/y!"), ["http://a.test/x", "https://b.test/y"]);
});

test("terminal quick select text tokens skip URL and file-link ranges", () => {
  const urlLine = "see https://example.com/192.168.1.12/7ec8346 and 7ec8346";
  const fileLine = "at src/app.ts:42:7 then count 42";

  const items = collectTerminalQuickSelectItems([urlLine, fileLine], "/repo");
  assert.deepEqual(items.map((item) => [item.kind, item.copyText]), [
    ["url", "https://example.com/192.168.1.12/7ec8346"],
    ["text", "7ec8346"],
    ["file", "src/app.ts:42:7"],
    ["text", "42"],
  ]);
  assert.deepEqual(findTerminalQuickSelectTextTokens("abc1234 10.0.0.1 17").map((item) => item.detail), [
    "Git hash",
    "IP address",
    "Number",
  ]);
});

test("terminal quick select range scans a bounded scrollback window around the viewport", () => {
  assert.equal(TERMINAL_QUICK_SELECT_SCOPE_LINES, 1000);
  assert.deepEqual(terminalQuickSelectRange(3000, 1500, 40), { start: 500, end: 2539 });
  assert.deepEqual(terminalQuickSelectRange(80, 0, 24), { start: 0, end: 79 });
  assert.deepEqual(terminalQuickSelectRange(120, 110, 40), { start: 0, end: 119 });
  assert.deepEqual(terminalQuickSelectRange(0, 10, 24), { start: 0, end: -1 });
});

test("terminal quick select hints use one or two character prefixes", () => {
  assert.equal(quickSelectHint(0), "a");
  assert.equal(quickSelectHint(25), "m");
  assert.equal(quickSelectHint(26), "aa");
  assert.equal(quickSelectHint(27), "as");
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
