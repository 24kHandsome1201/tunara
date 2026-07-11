import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const probe = readFileSync(new URL("../scripts/smoke-aider-semantics.sh", import.meta.url), "utf8");
const summary = readFileSync(new URL("../scripts/summarize-aider-semantics.py", import.meta.url), "utf8");
const environment = readFileSync(new URL("../scripts/fixtures/aider-isolated-probe.sh", import.meta.url), "utf8");

test("Aider semantics probe seeds history with local settings and captures Ctrl+Up/Down", () => {
  assert.match(probe, /'\/settings' Tab Enter/);
  assert.match(probe, /send-keys -t "\$session" C-Up/);
  assert.match(probe, /send-keys -t "\$session" C-Down/);
  assert.match(probe, /paste-buffer -p/);
  assert.match(probe, /Would you like to see what's new/);
});

test("Aider isolated environment disables side effects and removes all histories", () => {
  for (const flag of ["--no-git", "--no-auto-commits", "--no-check-update", "--no-analytics", "--no-browser", "--input-history-file", "--chat-history-file", "--llm-history-file"]) {
    assert.match(environment, new RegExp(flag));
  }
  assert.match(environment, /rm -rf "\$runtime"/);
});

test("Aider summary requires menu, local history, multiline, cancellation, and exit", () => {
  for (const check of ["slashMenuOpened", "slashMenuFiltered", "slashMenuCancelled", "localSettingsExecuted", "historyRestored", "historyReturnedToBlank", "multilineCancelled", "normalExitObserved"]) {
    assert.match(summary, new RegExp(`"${check}"`));
  }
  assert.match(summary, /"modelPromptSubmitted": False/);
  assert.match(summary, /cleanup\(args\.prefix\)/);
});
