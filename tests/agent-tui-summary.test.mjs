import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summarizer = resolve(root, "scripts/summarize-agent-tui.py");
const scopes = ["local", "ssh"];
const agents = ["claude", "codex", "pi", "opencode", "aider", "unknown"];
const keyMarkers = [
  "ESCAPE", "TAB", "SHIFT_TAB", "ARROW_UP", "ARROW_DOWN",
  "ARROW_LEFT", "ARROW_RIGHT", "CTRL_R", "MULTILINE", "CTRL_C",
];

const protocolBytes = [
  "\u001b[?1049h", "\u001b[?1049l", "\u001b[?2004h", "\u001b[?1004h",
  "\u001b[?1000h", "\u001b[38;2;1;2;3m", "中文", "🐾",
].join("");

function fixtureLog() {
  return [
    protocolBytes,
    "TUNARA_MULTILINE_A\nTUNARA_MULTILINE_B",
    "TUNARA_UNKNOWN_QUERY_RESPONSES:complete",
    "TUNARA_UNKNOWN_HIGH_OUTPUT:complete",
    "TUNARA_UNKNOWN_WAITING_CONFIRMATION:visible",
    "TUNARA_UNKNOWN_FAILURE:recoverable",
    "TUNARA_UNKNOWN_RESUME:ready",
    "TUNARA_UNKNOWN_RESIZE:40x120",
    "TUNARA_UNKNOWN_EXIT:interrupt",
    ...keyMarkers.map((name) => `TUNARA_UNKNOWN_KEY_${name}:observed`),
  ].join("\n");
}

test("Agent TUI summary records every key separately and counts completed probes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-agent-tui-summary-"));
  try {
    for (const scope of scopes) {
      mkdirSync(join(dir, scope));
      for (const agent of agents) {
        const base = join(dir, scope, agent);
        writeFileSync(`${base}.version`, "test-version\n");
        writeFileSync(`${base}.log`, agent === "unknown"
          ? fixtureLog()
          : "TUNARA_MULTILINE_A\nTUNARA_MULTILINE_B\n");
        writeFileSync(
          `${base}.summary`,
          "saw_output=1 resize_sent=1 interaction_sent=1 interaction_mask=1023 "
            + "exited_after_interrupt=1 exit_method_code=1 exit_stage_code=1 "
            + "normal_exit_observed=1 terminal_queries_answered=4\n",
        );
      }
    }

    const output = join(dir, "summary.json");
    const run = spawnSync("python3", [
      summarizer,
      "--input", dir,
      "--output", output,
      "--commit", "test-commit",
      "--target", "test-host",
      "--macos", "test-macos",
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);

    const result = JSON.parse(readFileSync(output, "utf8"));
    const probe = result.matrix.local.claude.inputProbe;
    assert.equal(probe.allKeysSent, true);
    assert.deepEqual(probe.keysSent, {
      escape: true,
      tab: true,
      shiftTab: true,
      arrowUp: true,
      arrowDown: true,
      arrowLeft: true,
      arrowRight: true,
      ctrlR: true,
      multiline: true,
      ctrlC: true,
    });
    assert.equal(result.matrix.local.unknown.contractPassed, true);
    assert.equal(result.matrix.ssh.unknown.contractPassed, true);
    assert.equal(result.summary.actualAgentEntriesFullInputProbe, 10);
    assert.equal(result.summary.actualAgentEntriesMultilineMarkersVisible, 10);
    assert.equal(result.summary.actualAgentEntriesNormalExitObserved, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
