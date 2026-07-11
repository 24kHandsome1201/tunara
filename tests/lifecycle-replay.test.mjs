import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgentCommand,
  detectCodexScreenState,
  detectPiScreenState,
  detectPromptAgentScreenState,
  hasCompletedAgentTurn,
  isSessionBusy,
  parseAgentLifecycleOsc,
  parseAgentHookEvent,
  sessionDisplayRunState,
  shouldUseStartupQuietReadyFallback,
} from "../src/modules/terminal/lib/agent-lifecycle.ts";
import { scanTerminalInputBuffer, shouldScanTerminalInput } from "../src/modules/terminal/lib/terminal-input-buffer.ts";
import { getTerminalTailText } from "../src/modules/terminal/lib/terminal-buffer-read.ts";
import {
  PROMPT_AGENT_STATE_CHECK_DELAY_MS,
  createPromptAgentScreenStateTracker,
} from "../src/modules/terminal/lib/terminal-prompt-agent-state.ts";
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
  terminalExitedUpdate,
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
import {
  buildAgentResumeCommand,
  hasContinueFlag,
  isResumableAgentInvocation,
  parseResumeId,
} from "../src/modules/terminal/lib/agent-resume.ts";
import { parseConEmuCwdOsc9 } from "../src/modules/terminal/lib/terminal-osc9.ts";
import { parseTerminalProgressOsc } from "../src/modules/terminal/lib/terminal-progress.ts";
import { DEFAULT_KEYBINDINGS, matchesKeybinding, parseKeybinding, sanitizeKeybindings } from "../src/modules/config/keybindings.ts";
import { collectTerminalBlockOutputText, findNavigableCommandBlock, findStickyCommandBlock, formatTerminalBlockCommandAndOutput, normalizeBlockCommand, resolveTerminalBlockRows } from "../src/modules/terminal/lib/terminal-blocks.ts";
import { deriveTitle } from "../src/ui/types.ts";
import { setLanguage } from "../src/modules/i18n/core.ts";
import {
  connectionDiagnostic,
  initialConnectionEvidence,
  reduceConnectionEvidence,
} from "../src/modules/terminal/lib/connection-state.ts";

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
    if (payload.event === "busy") {
      return apply(agentBusyUpdate(session, now));
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

function makeTailTerminal(lines, cursorY = lines.length - 1) {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY,
        length: lines.length,
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

test("SSH connection evidence replays backend phases without inferring readiness from the terminal", () => {
  let evidence = initialConnectionEvidence("ssh", "user", 10);
  assert.deepEqual(evidence, {
    transport: "ssh",
    phase: "pending",
    source: "user",
    updatedAt: 10,
  });

  evidence = reduceConnectionEvidence(evidence, { type: "openRequested", transport: "ssh" }, 20);
  evidence = reduceConnectionEvidence(evidence, { type: "backendPhase", transport: "ssh", phase: "handshaking" }, 30);
  evidence = reduceConnectionEvidence(evidence, { type: "hostKeyPrompt" }, 40);
  assert.equal(evidence.phase, "verifyingHostKey");
  assert.equal(evidence.source, "hostKey");

  evidence = reduceConnectionEvidence(evidence, { type: "backendPhase", transport: "ssh", phase: "authenticating" }, 50);
  evidence = reduceConnectionEvidence(evidence, { type: "backendPhase", transport: "ssh", phase: "openingShell" }, 60);
  evidence = reduceConnectionEvidence(evidence, { type: "ready", transport: "ssh", source: "backend" }, 70);
  assert.deepEqual(evidence, {
    transport: "ssh",
    phase: "ready",
    source: "backend",
    updatedAt: 70,
  });

  evidence = reduceConnectionEvidence(evidence, { type: "exit", transport: "ssh", code: -2, disconnected: true }, 80);
  assert.deepEqual(evidence, {
    transport: "ssh",
    phase: "disconnected",
    source: "transport",
    updatedAt: 80,
    exitCode: -2,
  });
});

test("connection failure evidence keeps the failed phase and produces bounded diagnostics", () => {
  let evidence = initialConnectionEvidence("ssh", "restore", 10);
  evidence = reduceConnectionEvidence(evidence, { type: "backendPhase", transport: "ssh", phase: "authenticating" }, 20);
  evidence = reduceConnectionEvidence(evidence, {
    type: "failed",
    transport: "ssh",
    reason: "auth",
    detail: `authentication failed\n${"x".repeat(700)}`,
    source: "renderer",
  }, 30);

  assert.equal(evidence.phase, "failed");
  assert.equal(evidence.failedAtPhase, "authenticating");
  assert.equal(evidence.detail.length, 500);
  assert.doesNotMatch(evidence.detail, /\n/);

  const replayed = reduceConnectionEvidence(evidence, {
    type: "failed",
    transport: "ssh",
    reason: "auth",
    detail: `authentication failed\n${"x".repeat(700)}`,
    source: "renderer",
  }, 40);
  assert.equal(replayed, evidence, "duplicate evidence must not churn the session state or timeline");

  const diagnostic = connectionDiagnostic({
    sessionId: "s-1",
    endpoint: "me@example.com:22",
    evidence,
  });
  assert.match(diagnostic, /phase=failed/);
  assert.match(diagnostic, /source=renderer/);
  assert.match(diagnostic, /failedAtPhase=authenticating/);
  assert.match(diagnostic, /reason=auth/);
});

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

test("remote Bash 3.2 prompt markers keep submitted-input command detection enabled", () => {
  assert.equal(shouldScanTerminalInput(false, false), true);
  assert.equal(shouldScanTerminalInput(true, false), false);
  assert.equal(shouldScanTerminalInput(true, true), true);
});

test("agent command detection maps first shell command token only", () => {
  assert.equal(detectAgentCommand("claude --dangerously-skip-permissions"), "CC");
  assert.equal(detectAgentCommand("\x1b[32mcodex\x1b[0m exec"), "CX");
  assert.equal(detectAgentCommand("ampcode"), "AM");
  assert.equal(detectAgentCommand("cursor-agent run task"), "CR");
  assert.equal(detectAgentCommand("agent run task"), null);
  assert.equal(detectAgentCommand("constructor"), null);
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
    "codex resume",
  );
  assert.equal(
    buildAgentResumeCommand({
      agent: "CC",
      command: "claude",
      cwd: "/repo",
      lastSeenAt: 1,
      confidence: "unknown",
    }),
    "claude --resume",
  );
  assert.equal(
    buildAgentResumeCommand({
      agent: "CX",
      command: "codex resume 019eef70-c6e4-7430-845c-26b1b68ecac5",
      cwd: "/repo",
      resumeId: "019eef70-c6e4-7430-845c-26b1b68ecac5",
      lastSeenAt: 1,
      confidence: "exact",
    }),
    "codex resume 019eef70-c6e4-7430-845c-26b1b68ecac5",
  );
});

test("parseResumeId extracts explicit ids but never flags", () => {
  // Real ids — the token after resume/--resume is a session id.
  assert.equal(parseResumeId("claude --resume abc-123"), "abc-123");
  assert.equal(parseResumeId("codex resume abc-123"), "abc-123");
  assert.equal(parseResumeId("codex exec resume 019eef70-c6e4-7430"), "019eef70-c6e4-7430");
  // Flags after resume are NOT ids — mistaking `--last` for a session id would
  // produce a broken `resume --last` resume command.
  assert.equal(parseResumeId("codex resume --last"), null);
  assert.equal(parseResumeId("codex resume --all"), null);
  assert.equal(parseResumeId("claude --resume --last"), null);
  // Bare launches and continue have no id.
  assert.equal(parseResumeId("claude"), null);
  assert.equal(parseResumeId("claude --continue"), null);
  assert.equal(parseResumeId("claude -r"), null);
});

test("hasContinueFlag detects continue invocations", () => {
  assert.equal(hasContinueFlag("claude --continue"), true);
  assert.equal(hasContinueFlag("codex resume continue"), true);
  assert.equal(hasContinueFlag("claude --resume abc"), false);
  assert.equal(hasContinueFlag("claude"), false);
});

test("utility agent invocations never create resumable sessions", () => {
  for (const command of [
    "claude --version",
    "claude --print hello",
    "claude auth login",
    "claude --model opus mcp list",
  ]) {
    assert.equal(isResumableAgentInvocation("CC", command), false, command);
  }
  for (const command of [
    "codex --version",
    "codex exec fix this",
    "codex --profile work mcp list",
    "codex login",
  ]) {
    assert.equal(isResumableAgentInvocation("CX", command), false, command);
  }
  assert.equal(isResumableAgentInvocation("CC", "claude explain this"), true);
  assert.equal(isResumableAgentInvocation("CC", "claude --resume abc"), true);
  assert.equal(isResumableAgentInvocation("CX", "codex resume abc"), true);
  assert.equal(isResumableAgentInvocation("DR", "droid"), false);
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

test("keybinding sanitizer ignores inherited object property names from user config", () => {
  const sanitized = sanitizeKeybindings({ constructor: "Mod+Q", new_terminal: "Mod+N" });
  assert.equal(sanitized.newTerminal, "Mod+N");
  assert.equal(sanitized.closeSession, DEFAULT_KEYBINDINGS.closeSession);
  assert.deepEqual(
    Object.keys(sanitized).filter((key) => !(key in DEFAULT_KEYBINDINGS)),
    [],
  );
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
  assert.deepEqual(pushRecentDir([], "/tmp/project "), ["/tmp/project "]);
  assert.deepEqual(collectRecentTerminalDirs(["/tmp/project "], undefined), [
    { dir: "/tmp/project ", label: "project " },
  ]);
  assert.deepEqual(sanitizeRecentDirs(["   ", "/tmp/project "]), ["/tmp/project "]);
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
  const inheritedPrefix = parseCommandPaletteQuery("constructor: api");
  assert.equal(inheritedPrefix.scope, undefined);
  assert.equal(inheritedPrefix.normalizedText, "constructor: api");
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
  const inheritedUsage = Object.create({ "used-action": 9 });
  assert.deepEqual(rankCommandPaletteItems(actions, parseCommandPaletteQuery("actions:"), inheritedUsage).map((item) => item.id), ["subtitle-hit", "used-action"]);
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
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", "/Users/me/repo "), "/Users/me/repo /src/main.rs");
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
  tracker.record("/Users/me/repo-c ", marker(16));

  assert.equal(duplicateMarker.isDisposed, true);
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(4)), "/Users/me/repo-a/src/main.rs");
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(12)), "/Users/me/repo-b/src/main.rs");
  assert.equal(resolveTerminalFileLinkPath("src/main.rs", tracker.getCwdForLine(20)), "/Users/me/repo-c /src/main.rs");
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
  assert.deepEqual(parseAgentLifecycleOsc("tunara-agent;busy;s-1;CC;"), {
    event: "busy",
    session: "s-1",
    agent: "CC",
  });
  assert.equal(parseAgentLifecycleOsc("other-agent;idle;s-1;CC;"), null);
});

test("agent lifecycle OSC carries a validated remote agent session id", () => {
  assert.deepEqual(
    parseAgentLifecycleOsc("tunara-agent;idle;s-1;CC;;550e8400-e29b-41d4-a716-446655440000"),
    {
      event: "idle",
      session: "s-1",
      agent: "CC",
      agentSessionId: "550e8400-e29b-41d4-a716-446655440000",
    },
  );
  assert.equal(
    parseAgentLifecycleOsc("tunara-agent;exit;s-1;CC;0junk;")?.code,
    undefined,
  );
  assert.equal(
    parseAgentLifecycleOsc("tunara-agent;exit;s-1;CC;999999999999999999999;")?.code,
    undefined,
  );
  assert.equal(parseAgentLifecycleOsc("tunara-agent;idle;s-1;CC;;bad;injected"), null);
});

test("native agent hook payloads are runtime-validated", () => {
  assert.deepEqual(
    parseAgentHookEvent({
      event: "stop",
      session: "s-123-1",
      agent: "CC",
      agentSessionId: "550e8400-e29b-41d4-a716-446655440000",
    }),
    {
      event: "stop",
      session: "s-123-1",
      agent: "CC",
      agentSessionId: "550e8400-e29b-41d4-a716-446655440000",
    },
  );
  assert.equal(parseAgentHookEvent({ event: "stop", session: "s-1", agent: "bogus" }), null);
  assert.equal(parseAgentHookEvent({ event: "exit", session: "s-1", code: 0 }), null);
  assert.equal(parseAgentHookEvent({ event: "exit", session: "s-1", code: "0" }), null);
  assert.equal(parseAgentHookEvent({ event: "idle", session: "../other", agent: "CC" }), null);
  assert.equal(parseAgentHookEvent({ event: "exit", session: "s-1", code: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal(parseAgentHookEvent({ event: "busy", session: "s-1", agent: "CC", code: 0 }), null);
  assert.equal(parseAgentHookEvent({ event: "busy", session: "s-1", agent: "CC" })?.event, "busy");
  assert.equal(parseAgentLifecycleOsc("tunara-agent;busy;s-1;CC;0"), null);
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

test("terminal paste protection guards multiline and large pastes", async () => {
  assert.equal(analyzeTerminalPaste("echo ok"), null);
  assert.deepEqual(analyzeTerminalPaste("echo one\necho two"), {
    charCount: 17,
    lineCount: 2,
    large: false,
    multiline: true,
  });
  assert.equal(analyzeTerminalPaste("x".repeat(TERMINAL_LARGE_PASTE_WARNING_LENGTH))?.large, undefined);
  assert.equal(analyzeTerminalPaste("x".repeat(TERMINAL_LARGE_PASTE_WARNING_LENGTH + 1))?.large, true);

  // A single trailing newline is the submit Enter, not an extra line.
  assert.equal(analyzeTerminalPaste("echo hi\n")?.lineCount, 1);
  assert.equal(analyzeTerminalPaste("echo one\necho two\n")?.lineCount, 2);
  // A blank line in the middle is a real line and still counts.
  assert.equal(analyzeTerminalPaste("a\n\nb")?.lineCount, 3);
  assert.equal(analyzeTerminalPaste("echo hi\r\n")?.lineCount, 1);

  const warning = analyzeTerminalPaste("echo one\necho two");
  assert.ok(warning);
  assert.match(terminalPasteWarningMessage(warning), /2 行/);

  // The confirmed paste is asynchronous (the confirmer may be the Tauri
  // dialog plugin); interception itself stays synchronous.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const pasted = [];
  const prompts = [];
  assert.equal(confirmProtectedTerminalPaste("echo ok", () => true, (text) => pasted.push(text)), false);
  assert.equal(confirmProtectedTerminalPaste("echo one\necho two", (message) => {
    prompts.push(message);
    return false;
  }, (text) => pasted.push(text)), true);
  await flush();
  assert.deepEqual(pasted, []);
  assert.equal(prompts.length, 1);

  assert.equal(confirmProtectedTerminalPaste("echo one\necho two", () => true, (text) => pasted.push(text)), true);
  assert.deepEqual(pasted, [], "paste must not happen before the confirmation resolves");
  await flush();
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

test("terminal quick select keeps a repeated token on different lines selectable", () => {
  // Same git hash on two lines must yield two selectable items (dedup keys on
  // line index), but a true duplicate on one line still collapses.
  const items = collectTerminalQuickSelectItems([
    "abc1234 here",
    "abc1234 there abc1234",
  ], "/repo");
  assert.deepEqual(items.map((item) => [item.kind, item.copyText]), [
    ["text", "abc1234"],
    ["text", "abc1234"],
  ]);
  assert.notEqual(items[0].id, items[1].id);
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

  assert.equal(h.applyAgentOsc("tunara-agent;busy;s-1;CC;", 30), true);
  assert.equal(h.session.agentActivity, "running");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(h.applyAgentOsc("tunara-agent;exit;s-1;CC;0", 40), true);
  assert.equal(h.session.agent, undefined);
  assert.equal(h.session.agentActivity, undefined);
  assert.equal(h.session.title, "终端");
  assert.equal(deriveTitle(h.session).primary, "终端");
  assert.equal(isSessionBusy(h.session), false);
  assert.equal(h.session.lastExitCode, 0);
  assert.equal(h.gitRefreshes, 1, "startup idle must not trigger an unnecessary git refresh");
});

test("terminal process exit updates session lifecycle even without OSC command end", () => {
  const h = createHarness(makeSession({
    lastCommand: "exit",
    runState: "running",
  }));

  assert.equal(h.apply(terminalExitedUpdate(h.session, 0, true, 50)), true);
  assert.equal(h.session.runState, "done");
  assert.equal(h.session.lastExitCode, 0);
  assert.equal(h.session.completedAt, 50);
  assert.equal(h.session.suppressShellTitle, true);
  assert.equal(h.session.lastCommand, "exit");
  assert.equal(h.gitRefreshes, 1);
});

test("terminal process exit clears stale agent state and marks background unread", () => {
  const h = createHarness(makeSession({
    agent: "CC",
    agentActivity: "running",
    title: "Claude Code",
    runState: "idle",
    lastCommand: "claude",
  }));

  assert.equal(h.apply(terminalExitedUpdate(h.session, 9, false, 60)), true);
  assert.equal(h.session.agent, undefined);
  assert.equal(h.session.agentActivity, undefined);
  assert.equal(h.session.title, "终端");
  assert.equal(h.session.lastCommand, undefined);
  assert.equal(h.session.lastExitCode, 9);
  assert.equal(h.session.runState, "failed");
  assert.equal(h.session.unread, true);
  assert.equal(deriveTitle(h.session).primary, "终端");
  assert.equal(h.gitRefreshes, 1);
});

test("agent session title appends live activity and falls back to the bare name", () => {
  const h = createHarness();

  // Agent detected → "starting" → name + 加载中.
  assert.equal(h.applyAgentOsc("tunara-agent;start;s-1;CC;", 10), true);
  assert.equal(h.session.agent, "CC");
  assert.equal(h.session.agentActivity, "starting");
  assert.equal(deriveTitle(h.session).primary, "Claude Code · 加载中");

  // Working → "running" → name + 运行中.
  assert.equal(h.applyAgentOsc("tunara-agent;busy;s-1;CC;", 20), true);
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
  assert.equal(startupUpdate.refreshGit, undefined);
  assert.equal(hasCompletedAgentTurn(startupReady), false);
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
  assert.equal(hasCompletedAgentTurn(activeDone), true);
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
  assert.equal(repeatedIdleUpdate, null, "duplicate ready events must be idempotent");
  assert.equal(sessionDisplayRunState(repeatedIdle), "done");
});

test("quiet ready fallback is startup-only and never completes an active agent turn", () => {
  assert.equal(shouldUseStartupQuietReadyFallback("CC", "starting"), true);
  assert.equal(shouldUseStartupQuietReadyFallback("DR", "starting"), true);

  assert.equal(shouldUseStartupQuietReadyFallback("CC", "running"), false);
  assert.equal(shouldUseStartupQuietReadyFallback("CC", "idle"), false);
  assert.equal(shouldUseStartupQuietReadyFallback("CX", "starting"), false);
  assert.equal(shouldUseStartupQuietReadyFallback(null, "starting"), false);
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
  assert.equal(h.session.agentActivity, "starting");
  assert.equal(isSessionBusy(h.session), true);

  assert.equal(detectCodexScreenState("Codex\n\n› "), "ready");
  assert.equal(h.apply(agentReadyUpdate(h.session, true, 15)), true);
  assert.equal(h.session.agentActivity, "idle");
  assert.equal(h.session.completedAt, undefined);

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

test("prompt agent screen tracker does not complete Codex startup while the first prompt is painting", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "starting" });
  const lines = ["Codex", "Working", "esc to interrupt"];
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createPromptAgentScreenStateTracker({
    terminal: makeTailTerminal(lines),
    getSessionId: () => "s-1",
    getCurrentSession: () => session,
    onBusy: () => {
      busyCount += 1;
      session = { ...session, agentActivity: "running" };
    },
    onReady: () => {
      readyCount += 1;
      session = { ...session, agentActivity: "idle" };
    },
  });

  tracker.schedule();
  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 0, "startup paint must not manufacture a running turn");
  assert.equal(readyCount, 0);
  assert.equal(session.agentActivity, "starting");

  lines.splice(0, lines.length, "Codex", "› ");
  tracker.schedule();
  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 0);
  assert.equal(readyCount, 1);
  assert.equal(session.agentActivity, "idle");

  tracker.dispose();
});

test("prompt agent screen tracker does not mark ready Codex prompt redraws as busy", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "idle" });
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createPromptAgentScreenStateTracker({
    terminal: makeTailTerminal(["Codex", "Working", "esc to interrupt", "› "]),
    getSessionId: () => "s-1",
    getCurrentSession: () => session,
    onBusy: () => {
      busyCount += 1;
      session = { ...session, agentActivity: "running" };
    },
    onReady: () => {
      readyCount += 1;
      session = { ...session, agentActivity: "idle" };
    },
  });

  tracker.schedule();
  assert.equal(busyCount, 0);

  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 0);
  assert.equal(readyCount, 0);

  tracker.dispose();
});

test("prompt agent screen tracker marks Codex busy from one semantic output update", async () => {
  let session = makeSession({ agent: "CX", agentActivity: "idle" });
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createPromptAgentScreenStateTracker({
    terminal: makeTailTerminal(["Codex", "› fix this", "Working", "esc to interrupt"]),
    getSessionId: () => "s-1",
    getCurrentSession: () => session,
    onBusy: () => {
      busyCount += 1;
      session = { ...session, agentActivity: "running" };
    },
    onReady: () => {
      readyCount += 1;
      session = { ...session, agentActivity: "idle" };
    },
  });

  tracker.schedule();
  assert.equal(busyCount, 0);

  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 1);
  assert.equal(readyCount, 0);

  tracker.dispose();
});

test("Pi screen replay gives the running indicator precedence over its ready footer", () => {
  const ready = [
    "pi v0.79.4",
    "~",
    "$0.000 (sub) 0.0%/272k (auto)  gpt-5.5 •",
  ].join("\n");
  const busy = [
    "$ sleep 2",
    "Running... (escape/ctrl+c to cancel)",
    "~",
    "$0.000 (sub) 0.0%/272k (auto)  gpt-5.5 •",
  ].join("\n");

  assert.equal(detectPiScreenState(ready), "ready");
  assert.equal(detectPiScreenState(busy), "busy");
  assert.equal(detectPromptAgentScreenState("PI", ready), "ready");
  assert.equal(detectPromptAgentScreenState("PI", busy), "busy");
});

test("Pi screen replay recognizes a ready footer clipped by a narrow split", () => {
  const narrowSplit = [
    "─────────────────────────────────",
    "~/code/pi5x/rail (main)",
    "$0.000 (sub) 0.0%/272k (auto)  gp",
  ].join("\n");

  assert.equal(detectPiScreenState(narrowSplit), "ready");
});

test("terminal tail includes bounded TUI status rows below the input cursor", () => {
  const terminal = makeTailTerminal([
    "Pi",
    "input cursor",
    "─────────────────────────────────",
    "~/code/pi5x/rail (main)",
    "$0.000 (sub) 0.0%/272k (auto)  gp",
    "",
  ], 1);

  const tail = getTerminalTailText(terminal, 12);
  assert.match(tail, /input cursor/);
  assert.match(tail, /\$0\.000 \(sub\) 0\.0%\/272k \(auto\)/);
  assert.equal(detectPiScreenState(tail), "ready");
});

test("prompt agent screen tracker moves Pi from startup and running back to ready", async () => {
  let session = makeSession({ agent: "PI", agentActivity: "starting" });
  const lines = ["pi v0.79.4", "~", "$0.000 (sub) 0.0%/272k (auto)  gpt-5.5 •"];
  let busyCount = 0;
  let readyCount = 0;
  const tracker = createPromptAgentScreenStateTracker({
    terminal: makeTailTerminal(lines),
    getSessionId: () => "s-pi",
    getCurrentSession: () => session,
    onBusy: () => {
      busyCount += 1;
      session = { ...session, agentActivity: "running" };
    },
    onReady: () => {
      readyCount += 1;
      session = { ...session, agentActivity: "idle" };
    },
  });

  tracker.schedule();
  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(readyCount, 1);
  assert.equal(session.agentActivity, "idle");

  session = { ...session, agentActivity: "running" };
  lines.splice(0, lines.length,
    "$ sleep 2",
    "Running... (escape/ctrl+c to cancel)",
    "~",
    "$0.000 (sub) 0.0%/272k (auto)  gpt-5.5 •",
  );
  tracker.schedule();
  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(busyCount, 0, "submitted input already establishes the running transition");
  assert.equal(session.agentActivity, "running");

  lines.splice(0, lines.length, "~", "$0.000 (sub) 0.0%/272k (auto)  gpt-5.5 •");
  tracker.schedule();
  await new Promise((resolve) => setTimeout(resolve, PROMPT_AGENT_STATE_CHECK_DELAY_MS + 20));
  assert.equal(readyCount, 2);
  assert.equal(session.agentActivity, "idle");

  tracker.dispose();
});

test("OSC 7 cwd replay updates sidebar directory and clears stale git context", () => {
  const h = createHarness(makeSession({
    branch: "main",
    changes: {
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
