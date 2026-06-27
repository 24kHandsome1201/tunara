import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgentCommand,
  detectCodexScreenState,
  isSessionBusy,
  parseAgentLifecycleOsc,
  sessionDisplayRunState,
  shouldUseStartupQuietReadyFallback,
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
import { createTerminalLineCwdTracker } from "../src/modules/terminal/lib/terminal-line-cwd.ts";
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
  filterCommandPaletteItems,
  parseCommandPaletteQuery,
  rankCommandPaletteItems,
} from "../src/ui/overlays/command-palette-filter.ts";
import { collectRecentTerminalCommands, collectRecentTerminalDirs } from "../src/ui/overlays/command-palette-recents.ts";
import { pushRecentCommand, sanitizeRecentCommands } from "../src/state/recent-commands.ts";
import { pushRecentDir, sanitizeRecentDirs } from "../src/state/recent-dirs.ts";
import {
  TERMINAL_LARGE_PASTE_WARNING_LENGTH,
  analyzeTerminalPaste,
  confirmProtectedTerminalPaste,
  terminalPasteWarningMessage,
} from "../src/modules/terminal/lib/terminal-paste-protection.ts";
import {
  filterTerminalBlockOutput,
  formatTerminalBlockFilterText,
} from "../src/modules/terminal/lib/terminal-block-filter.ts";
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
  shellTitleUpdate,
  terminalProgressUpdate,
} from "../src/modules/terminal/lib/session-lifecycle.ts";
import {
  parseTerminalNotificationOsc9,
  parseTerminalNotificationOsc777,
} from "../src/modules/terminal/lib/terminal-notification.ts";
import {
  handleTerminalClipboardOsc52,
  MAX_OSC52_CLIPBOARD_BYTES,
  parseTerminalClipboardWriteOsc52,
} from "../src/modules/terminal/lib/terminal-clipboard.ts";
import {
  buildPrimaryDeviceAttributesResponse,
  handlePrimaryDeviceAttributesQuery,
} from "../src/modules/terminal/lib/terminal-device-attributes.ts";
import { buildAgentResumeCommand } from "../src/modules/terminal/lib/agent-resume.ts";
import { parseConEmuCwdOsc9 } from "../src/modules/terminal/lib/terminal-osc9.ts";
import { parseTerminalProgressOsc } from "../src/modules/terminal/lib/terminal-progress.ts";
import { matchesKeybinding, parseKeybinding } from "../src/modules/config/keybindings.ts";
import { collectTerminalBlockOutputText, findNavigableCommandBlock, findStickyCommandBlock, formatTerminalBlockCommandAndOutput, normalizeBlockCommand, resolveTerminalBlockRows } from "../src/modules/terminal/lib/terminal-blocks.ts";
import { deriveTitle } from "../src/ui/types.ts";
import { setLanguage } from "../src/modules/i18n/index.ts";

// Agent title suffixes go through i18n; pin the locale so assertions are
// deterministic regardless of the host's navigator.language.
setLanguage("zh-CN");

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

function makeMarker(line) {
  return {
    line,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
      this.line = -1;
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

test("agent resume command never falls back to the bare startup command", () => {
  assert.equal(
    buildAgentResumeCommand({
      agent: "CX",
      command: "codex",
      cwd: "/repo",
      lastSeenAt: 1,
      confidence: "unknown",
    }),
    "codex exec resume --last",
  );
  assert.equal(
    buildAgentResumeCommand({
      agent: "CC",
      command: "claude",
      cwd: "/repo",
      lastSeenAt: 1,
      confidence: "unknown",
    }),
    "claude --continue",
  );
  assert.equal(
    buildAgentResumeCommand({
      agent: "CX",
      command: "codex exec resume 019eef70-c6e4-7430-845c-26b1b68ecac5",
      cwd: "/repo",
      resumeId: "019eef70-c6e4-7430-845c-26b1b68ecac5",
      lastSeenAt: 1,
      confidence: "exact",
    }),
    "codex exec resume 019eef70-c6e4-7430-845c-26b1b68ecac5",
  );
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

test("keybinding matcher handles shifted bracket characters", () => {
  const leftBraceEvent = { key: "{", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
  const rightBraceEvent = { key: "}", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };

  assert.equal(matchesKeybinding(leftBraceEvent, "Mod+Shift+[", true), true);
  assert.equal(matchesKeybinding(rightBraceEvent, "Mod+Shift+]", true), true);
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

test("terminal block output reads marker-adjusted rows after scrollback movement", () => {
  const block = {
    startRow: 10,
    endRow: 12,
    startMarker: makeMarker(1),
    endMarker: makeMarker(3),
  };

  assert.deepEqual(resolveTerminalBlockRows(block), { startRow: 1, endRow: 3 });
  assert.equal(
    collectTerminalBlockOutputText(["old", "$ pnpm test", "pass 1", "pass 2"], block),
    "pass 1\npass 2",
  );
});

test("terminal block output does not fall back to stale rows after markers are disposed", () => {
  const startMarker = makeMarker(1);
  const block = {
    startRow: 0,
    endRow: 2,
    startMarker,
    endMarker: makeMarker(2),
  };

  startMarker.dispose();
  assert.equal(resolveTerminalBlockRows(block), null);
  assert.equal(collectTerminalBlockOutputText(["$ stale", "wrong output", ""], block), "");
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

test("terminal block output filter keeps scoped matches and context lines", () => {
  const output = [
    "compile app",
    "warning: unused import",
    "test passed",
    "ERROR: failed snapshot",
    "cleanup done",
  ].join("\n");

  assert.deepEqual(filterTerminalBlockOutput(output, {
    query: "",
    regex: false,
    caseSensitive: false,
    invert: false,
    contextLines: 0,
  }).lines.map((line) => line.text), output.split("\n"));

  const plain = filterTerminalBlockOutput(output, {
    query: "error",
    regex: false,
    caseSensitive: false,
    invert: false,
    contextLines: 1,
  });
  assert.equal(plain.selectedCount, 1);
  assert.deepEqual(plain.lines.map((line) => [line.index, line.selected, line.context]), [
    [2, false, true],
    [3, true, false],
    [4, false, true],
  ]);
  assert.equal(formatTerminalBlockFilterText(plain), "test passed\nERROR: failed snapshot\ncleanup done");

  const inverted = filterTerminalBlockOutput(output, {
    query: "^(warning|ERROR)",
    regex: true,
    caseSensitive: true,
    invert: true,
    contextLines: 0,
  });
  assert.deepEqual(inverted.lines.map((line) => line.text), ["compile app", "test passed", "cleanup done"]);

  assert.equal(filterTerminalBlockOutput(output, {
    query: "[",
    regex: true,
    caseSensitive: false,
    invert: false,
    contextLines: 0,
  }).invalidRegex, true);
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

test("command palette surfaces recently used terminal directories without duplicating active cwd", () => {
  let recentDirs = [];
  recentDirs = pushRecentDir(recentDirs, "/Users/me/current");
  recentDirs = pushRecentDir(recentDirs, "/Users/me/api");
  recentDirs = pushRecentDir(recentDirs, "/Users/me/web");
  recentDirs = pushRecentDir(recentDirs, "/Users/me/api");

  assert.deepEqual(recentDirs, ["/Users/me/api", "/Users/me/web", "/Users/me/current"]);
  assert.deepEqual(collectRecentTerminalDirs(recentDirs, "/Users/me/current"), [
    { dir: "/Users/me/api", label: "api" },
    { dir: "/Users/me/web", label: "web" },
  ]);
  assert.deepEqual(collectRecentTerminalDirs(recentDirs, "/Users/me/current", 1), [
    { dir: "/Users/me/api", label: "api" },
  ]);
  assert.deepEqual(sanitizeRecentDirs(["", "/tmp/a", "/tmp/a", 42, "/tmp/b"]), ["/tmp/a", "/tmp/b"]);
});

test("command palette recent commands are deduped and prepared for safe prefill", () => {
  let recentCommands = [];
  recentCommands = pushRecentCommand(recentCommands, "pnpm test");
  recentCommands = pushRecentCommand(recentCommands, "cargo clippy");
  recentCommands = pushRecentCommand(recentCommands, "pnpm test");

  assert.deepEqual(recentCommands, ["pnpm test", "cargo clippy"]);
  assert.deepEqual(collectRecentTerminalCommands(recentCommands, "cargo clippy"), [
    { command: "pnpm test", label: "pnpm test" },
  ]);
  assert.deepEqual(collectRecentTerminalCommands(["echo one\necho two", "pnpm test"], undefined), [
    { command: "pnpm test", label: "pnpm test" },
  ]);
  assert.deepEqual(pushRecentCommand(recentCommands, "echo one\necho two"), recentCommands);
  assert.deepEqual(sanitizeRecentCommands(["", "pnpm test", "pnpm test", 42, "cargo clippy", "echo one\necho two"]), ["pnpm test", "cargo clippy"]);
});

test("command palette typed filters narrow results by scope before text matching", () => {
  const items = [
    { id: "switch-api", label: "api", subtitle: "/repo/api", section: "会话", scopes: ["session"], originalIndex: 0 },
    { id: "new-terminal", label: "新建终端", section: "操作", scopes: ["action", "terminal"], originalIndex: 1 },
    { id: "recent-command", label: "填入最近命令: pnpm test", subtitle: "/repo/web", section: "最近命令", scopes: ["action", "terminal", "recent"], originalIndex: 2 },
    { id: "settings", label: "设置", section: "操作", scopes: ["action", "app"], originalIndex: 3 },
  ];

  assert.deepEqual(
    filterCommandPaletteItems(items, parseCommandPaletteQuery("sessions: api")).map((item) => item.id),
    ["switch-api"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, parseCommandPaletteQuery("terminal: pnpm")).map((item) => item.id),
    ["recent-command"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, parseCommandPaletteQuery("actions:")).map((item) => item.id),
    ["new-terminal", "recent-command", "settings"],
  );
  assert.deepEqual(
    filterCommandPaletteItems(items, parseCommandPaletteQuery("unknown: api")).map((item) => item.id),
    [],
  );
});

test("command palette ranking prefers label matches before subtitle-only matches", () => {
  const items = [
    { id: "subtitle-hit", label: "打开设置", subtitle: "/repo/api", section: "操作", scopes: ["action"], originalIndex: 0 },
    { id: "label-hit", label: "api", section: "会话", scopes: ["session"], originalIndex: 1 },
    { id: "used-action", label: "刷新 Git", section: "操作", scopes: ["action"], originalIndex: 2 },
  ];

  const parsed = parseCommandPaletteQuery("api");
  const filtered = filterCommandPaletteItems(items, parsed);
  assert.deepEqual(filtered.map((item) => item.id), ["subtitle-hit", "label-hit"]);
  assert.deepEqual(rankCommandPaletteItems(filtered, parsed, {}).map((item) => item.id), ["label-hit", "subtitle-hit"]);
  const actions = filterCommandPaletteItems(items, parseCommandPaletteQuery("actions:"));
  assert.deepEqual(rankCommandPaletteItems(actions, parseCommandPaletteQuery("actions:"), { "used-action": 4 }).map((item) => item.id), ["used-action", "subtitle-hit"]);
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

test("terminal file links resolve relative paths from the cwd active for that line", () => {
  const marker = (line) => ({
    line,
    isDisposed: false,
    dispose() {
      this.isDisposed = true;
    },
  });
  const tracker = createTerminalLineCwdTracker();
  const duplicateMarker = marker(3);
  tracker.record("/Users/me/repo-a", marker(0));
  tracker.record("/Users/me/repo-a", duplicateMarker);
  tracker.record("/Users/me/repo-b", marker(8));

  assert.equal(duplicateMarker.isDisposed, true);
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(4)), "/Users/me/repo-a/src/main.rs");
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(12)), "/Users/me/repo-b/src/main.rs");
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(1, "/fallback")), "/Users/me/repo-a/src/main.rs");

  tracker.dispose();
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(12, "/fallback")), "/fallback/src/main.rs");
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

test("terminal progress OSC 9;4 is parsed and kept as session runtime state", () => {
  assert.deepEqual(parseTerminalProgressOsc("4;1;42.4", 100), {
    progress: { state: "normal", value: 42, updatedAt: 100 },
  });
  assert.deepEqual(parseTerminalProgressOsc("4;2", 101), {
    progress: { state: "error", updatedAt: 101 },
  });
  assert.deepEqual(parseTerminalProgressOsc("4;3;88", 102), {
    progress: { state: "indeterminate", updatedAt: 102 },
  });
  assert.deepEqual(parseTerminalProgressOsc("4;4;140", 103), {
    progress: { state: "warning", value: 100, updatedAt: 103 },
  });
  assert.deepEqual(parseTerminalProgressOsc("4;0", 104), { progress: null });
  assert.equal(parseTerminalProgressOsc("1;hello", 105), null);
  assert.equal(parseTerminalProgressOsc("4;1", 106), null);

  let session = makeSession();
  const progressUpdate = terminalProgressUpdate(session, { state: "normal", value: 50, updatedAt: 110 });
  session = { ...session, ...progressUpdate.patch };
  assert.equal(session.terminalProgress.value, 50);
  const warningUpdate = terminalProgressUpdate(session, { state: "warning", updatedAt: 111 });
  session = { ...session, ...warningUpdate.patch };
  assert.equal(session.terminalProgress.value, 50);
  assert.equal(session.terminalProgress.state, "warning");
  const commandUpdate = commandDetectedUpdate(session, "pnpm build", 120);
  session = { ...session, ...commandUpdate.patch };
  assert.equal(session.terminalProgress, undefined);
});

test("terminal notification OSC sequences avoid ConEmu progress and cwd collisions", () => {
  assert.deepEqual(parseTerminalNotificationOsc9("Build finished"), {
    title: "Build finished",
  });
  assert.deepEqual(parseTerminalNotificationOsc9("  Needs approval\nnow  "), {
    title: "Needs approval now",
  });
  assert.equal(parseTerminalNotificationOsc9("4;1;42"), null);
  assert.equal(parseTerminalNotificationOsc9("9;/Users/me/repo"), null);
  assert.equal(parseTerminalNotificationOsc9(""), null);

  assert.deepEqual(parseTerminalNotificationOsc777("notify;Claude Code;Needs approval"), {
    title: "Claude Code",
    body: "Needs approval",
  });
  assert.deepEqual(parseTerminalNotificationOsc777("notify;;Only body"), {
    title: "终端通知",
    body: "Only body",
  });
  assert.equal(parseTerminalNotificationOsc777("tunara-agent;start;s-1;CC;"), null);
  assert.equal(parseTerminalNotificationOsc777("conduit-agent;start;s-1;CC;"), null);
  assert.equal(parseTerminalNotificationOsc777("notify;;"), null);
});

test("agent lifecycle OSC accepts current and legacy event prefixes", () => {
  assert.deepEqual(parseAgentLifecycleOsc("tunara-agent;start;s-1;CC;"), {
    event: "start",
    session: "s-1",
    agent: "CC",
  });
  assert.deepEqual(parseAgentLifecycleOsc("conduit-agent;idle;s-1;CC;"), {
    event: "idle",
    session: "s-1",
    agent: "CC",
  });
  assert.equal(parseAgentLifecycleOsc("other-agent;idle;s-1;CC;"), null);
});

test("ConEmu OSC 9;9 cwd is parsed as a terminal cwd fallback", () => {
  assert.equal(parseConEmuCwdOsc9("9;/Users/me/repo"), "/Users/me/repo");
  assert.equal(parseConEmuCwdOsc9('9;"/Users/me/repo"'), "/Users/me/repo");
  assert.equal(parseConEmuCwdOsc9("9;~/work"), "~/work");
  assert.equal(parseConEmuCwdOsc9("9;file://localhost/Users/me/repo"), "/Users/me/repo");
  assert.equal(parseConEmuCwdOsc9("4;1;42"), null);
  assert.equal(parseConEmuCwdOsc9("9;relative/path"), null);
  assert.equal(parseConEmuCwdOsc9("9;/tmp/\nrepo"), null);
});

test("OSC 52 clipboard writes decode text only within the safety limit", () => {
  assert.deepEqual(parseTerminalClipboardWriteOsc52("c;aGVsbG8gd29ybGQ="), {
    target: "c",
    text: "hello world",
  });
  assert.deepEqual(parseTerminalClipboardWriteOsc52(";5Lit5paH"), {
    target: "c",
    text: "中文",
  });
  assert.equal(parseTerminalClipboardWriteOsc52("c;?"), null);
  assert.equal(parseTerminalClipboardWriteOsc52("c;not base64!"), null);
  assert.equal(parseTerminalClipboardWriteOsc52("c;////"), null);
  assert.equal(parseTerminalClipboardWriteOsc52("c;aGVsbG8=", 4), null);
  assert.equal(MAX_OSC52_CLIPBOARD_BYTES, 256 * 1024);
});

test("OSC 52 clipboard handler only writes when explicitly allowed", () => {
  const writes = [];
  const writeText = async (text) => {
    writes.push(text);
  };

  assert.equal(handleTerminalClipboardOsc52("c;aGVsbG8=", { isWriteAllowed: () => false, writeText }), true);
  assert.deepEqual(writes, []);
  assert.equal(handleTerminalClipboardOsc52("c;?", { isWriteAllowed: () => true, writeText }), true);
  assert.deepEqual(writes, []);
  assert.equal(handleTerminalClipboardOsc52("c;aGVsbG8=", { isWriteAllowed: () => true, writeText }), true);
  assert.deepEqual(writes, ["hello"]);
  assert.equal(handleTerminalClipboardOsc52("malformed", { isWriteAllowed: () => true, writeText }), false);
});

test("primary device attributes advertise OSC 52 only when clipboard writes are enabled", () => {
  assert.equal(buildPrimaryDeviceAttributesResponse(false), "\x1b[?1;2c");
  assert.equal(buildPrimaryDeviceAttributesResponse(true), "\x1b[?1;2;52c");

  const writes = [];
  const options = {
    isOsc52ClipboardWriteAllowed: () => true,
    sendInput: (data) => writes.push(data),
  };
  assert.equal(handlePrimaryDeviceAttributesQuery([], options), true);
  assert.equal(handlePrimaryDeviceAttributesQuery([0], options), true);
  assert.deepEqual(writes, ["\x1b[?1;2;52c", "\x1b[?1;2;52c"]);

  assert.equal(handlePrimaryDeviceAttributesQuery([1], options), true);
  assert.deepEqual(writes, ["\x1b[?1;2;52c", "\x1b[?1;2;52c"]);
  assert.equal(handlePrimaryDeviceAttributesQuery([0, 1], options), false);
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

  assert.equal(h.applyAgentOsc("tunara-agent;start;s-1;CC;", 10), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "starting");
  assert.equal(deriveTitle(h.session).primary, "Claude Code · 加载中");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(h.applyAgentOsc("tunara-agent;idle;s-1;CC;", 20), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(isSessionBusy(h.session), false);

  assert.equal(h.apply(agentBusyUpdate(h.session, 30)), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(h.applyAgentOsc("tunara-agent;exit;s-1;CC;0", 40), true);
  assert.equal(h.session.agent, undefined);
  assert.equal(h.session.agentActivity, undefined);
  assert.equal(h.session.title, "终端");
  assert.equal(deriveTitle(h.session).primary, "终端");
  assert.equal(isSessionBusy(h.session), false);
  assert.equal(h.session.lastExitCode, 0);
  assert.equal(h.gitRefreshes, 2);
});

test("agent session title appends live activity and falls back to the bare name", () => {
  const h = createHarness();

  // Agent detected → "starting" → name + 加载中.
  assert.equal(h.applyAgentOsc("tunara-agent;start;s-1;CC;", 10), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "starting");
  assert.equal(deriveTitle(h.session).primary, "Claude Code · 加载中");

  // Working → "running" → name + 运行中.
  assert.equal(h.apply(agentBusyUpdate(h.session, 20)), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(deriveTitle(h.session).primary, "Claude Code · 运行中");

  // Idle (waiting for input) → no suffix, just the agent name.
  assert.equal(h.applyAgentOsc("tunara-agent;idle;s-1;CC;", 30), true);
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(deriveTitle(h.session).primary, "Claude Code");

  // Agent sessions never adopt an OSC shellTitle — those are just the agent name.
  assert.equal(shellTitleUpdate(h.session, "✳ Claude Code"), null);
  assert.equal(shellTitleUpdate(h.session, "anything else"), null);

  // On exit the title drops back to the default.
  assert.equal(h.applyAgentOsc("tunara-agent;exit;s-1;CC;0", 40), true);
  assert.equal(h.session.agent, undefined);
  assert.equal(deriveTitle(h.session).primary, "终端");
});

test("agent ready distinguishes startup idle from completed turns for sidebar state", () => {
  const startup = makeSession({
    agent: "CC",
    agentActivity: "starting",
    completedAt: undefined,
  });
  const startupUpdate = agentReadyUpdate(startup, true, 10);
  const startupReady = { ...startup, ...startupUpdate.patch };

  assert.equal(startupReady.completedAt, undefined);
  assert.equal(startupReady.unread, undefined);
  assert.equal(sessionDisplayRunState(startupReady), "idle");

  const backgroundStartupUpdate = agentReadyUpdate(startup, false, 15);
  const backgroundStartupReady = { ...startup, ...backgroundStartupUpdate.patch };

  assert.equal(backgroundStartupReady.completedAt, undefined);
  assert.equal(backgroundStartupReady.unread, undefined);
  assert.equal(sessionDisplayRunState(backgroundStartupReady), "idle");

  const running = makeSession({
    agent: "CC",
    agentActivity: "running",
    completedAt: undefined,
  });
  const activeUpdate = agentReadyUpdate(running, true, 20);
  const activeDone = { ...running, ...activeUpdate.patch };

  assert.equal(activeDone.completedAt, 20);
  assert.equal(activeDone.unread, undefined);
  assert.equal(sessionDisplayRunState(activeDone), "done");
  assert.equal(isSessionBusy(activeDone), false);

  const backgroundUpdate = agentReadyUpdate(running, false, 30);
  const backgroundDone = { ...running, ...backgroundUpdate.patch };

  assert.equal(backgroundDone.completedAt, 30);
  assert.equal(backgroundDone.unread, true);
  assert.equal(sessionDisplayRunState(backgroundDone), "done");

  const repeatedIdle = makeSession({
    agent: "CC",
    agentActivity: "idle",
    completedAt: 30,
    unread: false,
  });
  const repeatedIdleUpdate = agentReadyUpdate(repeatedIdle, false, 40);
  const repeatedIdleDone = { ...repeatedIdle, ...repeatedIdleUpdate.patch };

  assert.equal(repeatedIdleDone.completedAt, 30);
  assert.equal(repeatedIdleDone.unread, false);
  assert.equal(sessionDisplayRunState(repeatedIdleDone), "done");
});

test("quiet ready fallback is startup-only and never completes an active agent turn", () => {
  assert.equal(shouldUseStartupQuietReadyFallback("CC", "starting", true), true);
  assert.equal(shouldUseStartupQuietReadyFallback("DR", "starting", true), true);

  assert.equal(shouldUseStartupQuietReadyFallback("CC", "running", true), false);
  assert.equal(shouldUseStartupQuietReadyFallback("CC", "running", false), false);
  assert.equal(shouldUseStartupQuietReadyFallback("CC", "idle", true), false);
  assert.equal(shouldUseStartupQuietReadyFallback("CX", "starting", true), false);
  assert.equal(shouldUseStartupQuietReadyFallback(null, "starting", true), false);
});

test("lifecycle events for another session are ignored", () => {
  const h = createHarness();

  assert.equal(h.applyAgentOsc("tunara-agent;start;s-2;CC;", 10), false);
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
  assert.equal(detectCodexScreenState("Codex\n› fix this\nWorking\nesc to interrupt"), "busy");
  assert.equal(detectCodexScreenState("Codex\nWorking\nesc to interrupt\n› "), "ready");
  assert.equal(h.apply(agentBusyUpdate(h.session, 20)), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(detectCodexScreenState("Codex\n\n› "), "ready");
  assert.equal(h.apply(agentReadyUpdate(h.session, true, 30)), true);
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(isSessionBusy(h.session), false);
});

test("Codex screen tracker does not mark ready prompt redraws as busy", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "idle" });
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createCodexScreenStateTracker({
    terminal: makeTailTerminal(["Codex", "Working", "esc to interrupt", "› "]),
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
  assert.equal(busyCount, 0);

  await new Promise((resolve) => setTimeout(resolve, CODEX_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 0);
  assert.equal(readyCount, 0);

  tracker.dispose();
});

test("Codex screen tracker marks busy after the active turn shows work", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "idle" });
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createCodexScreenStateTracker({
    terminal: makeTailTerminal(["Codex", "› fix this", "Working", "esc to interrupt"]),
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

  for (let i = 0; i < CODEX_DATA_BURST_BUSY_THRESHOLD; i += 1) {
    tracker.schedule();
  }
  assert.equal(busyCount, 0);

  await new Promise((resolve) => setTimeout(resolve, CODEX_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 1);
  assert.equal(readyCount, 0);

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
