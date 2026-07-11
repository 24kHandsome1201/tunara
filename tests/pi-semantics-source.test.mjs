import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const probe = readFileSync(new URL("../scripts/smoke-pi-semantics.sh", import.meta.url), "utf8");
const summary = readFileSync(new URL("../scripts/summarize-pi-semantics.py", import.meta.url), "utf8");

test("Pi semantics probe uses a model-free shell seed for real Up/Down history", () => {
  assert.match(probe, /!!sleep 2/);
  assert.match(probe, /capture shell-busy/);
  assert.match(probe, /capture shell-ready/);
  assert.match(probe, /!!printf TUNARA_PI_HISTORY_SEED/);
  assert.match(probe, /send-keys -t "\$session" Up/);
  assert.match(probe, /capture history-up/);
  assert.match(probe, /send-keys -t "\$session" Down/);
  assert.match(probe, /capture history-down/);
  assert.match(probe, /paste-buffer -p/);
});

test("Pi semantics summary requires ready/busy recovery, menu, history, multiline, cancel, and exit", () => {
  for (const check of ["shellBusyVisible", "shellReturnedToReady", "slashMenuOpened", "slashMenuFiltered", "slashMenuCancelled", "historyRestored", "historyReturnedToBlank", "multilineCancelled", "normalExitObserved"]) {
    assert.match(summary, new RegExp(`"${check}"`));
  }
  assert.match(summary, /"modelPromptSubmitted": False/);
  assert.match(summary, /"passed": all\(checks\.values\(\)\)/);
  assert.match(summary, /cleanup\(args\.prefix\)/);
});
