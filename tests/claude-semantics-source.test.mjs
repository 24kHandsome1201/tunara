import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const expectProbe = readFileSync(new URL("../scripts/smoke-claude-semantics.exp", import.meta.url), "utf8");
const summarizer = readFileSync(new URL("../scripts/summarize-claude-semantics.py", import.meta.url), "utf8");

test("Claude semantics probe captures every interaction in a separate stage", () => {
  for (const stage of [
    "shift-tab-1", "shift-tab-2", "shift-tab-3", "shift-tab-4",
    "slash-menu", "slash-filter", "slash-filter-clear", "slash-down", "slash-up", "slash-cancel",
    "history", "history-cancel", "multiline", "multiline-cancel", "exit",
  ]) {
    assert.match(expectProbe, new RegExp(`capture_stage \\$child \\$log_prefix ${stage.replaceAll("-", "\\-")}`));
  }
  assert.match(expectProbe, /log_user 0/);
  assert.match(expectProbe, /TUNARA_CLAUDE_SEMANTIC_A\\nTUNARA_CLAUDE_SEMANTIC_B/);
});

test("Claude semantics summary requires mode, menu, history, multiline, cancel, and exit evidence", () => {
  for (const check of [
    "modeCycleChanged",
    "acceptEditsVisible",
    "planModeVisible",
    "slashMenuFiltered",
    "slashFilterCleared",
    "slashSelectionOutputObserved",
    "slashChoiceChanged",
    "slashMenuCancelled",
    "historySearchOpened",
    "historySearchCancelled",
    "multilineCancelled",
    "normalExitObserved",
  ]) {
    assert.match(summarizer, new RegExp(`"${check}"`));
  }
  assert.match(summarizer, /if key not in \{"slashMenuFiltered", "slashFilterCleared", "slashSelectionOutputObserved"\}/);
  assert.match(summarizer, /\(filter_applied and filter_cleared\) or selection_observed/);
  assert.match(summarizer, /remove_stage_logs\(args\.prefix\)/);
  assert.match(summarizer, /unlink\(missing_ok=True\)/);
  assert.match(summarizer, /result\.get\("child_exited"\) == 1 and result\.get\("exit_status"\) == 0/);
  assert.match(summarizer, /all\(command\.startswith\(menu_filter\) for command in slash_filter_commands\)/);
  assert.match(summarizer, /slash_menu_commands \| slash_filter_commands/);
  assert.match(summarizer, /cursor_positioned \| space_aligned/);
  assert.match(summarizer, /return 0 if payload\["passed"\] else 1/);
});
