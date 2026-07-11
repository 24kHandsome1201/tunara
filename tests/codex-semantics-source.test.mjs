import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const probe = readFileSync(new URL("../scripts/smoke-codex-semantics.sh", import.meta.url), "utf8");
const summary = readFileSync(new URL("../scripts/summarize-codex-semantics.py", import.meta.url), "utf8");

test("Codex semantics probe refuses hook trust and captures stable tmux screens", () => {
  assert.match(probe, /Down Down Enter/);
  assert.match(probe, /trust_denied=1/);
  assert.match(probe, /! grep -Eq 'Booting MCP\|Starting MCP servers'/);
  assert.match(probe, /if ! wait_for_text '\^  \/permissions' 20; then[\s\S]*C-c[\s\S]*wait_for_text '\^  \/permissions' 20 \|\| true/);
  assert.match(probe, /wait_for_text '\^\[›>\] \/perm\$' 20 \|\| true/);
  assert.match(probe, /paste-buffer -p/);
  assert.match(probe, /TUNARA_CODEX_SEMANTIC_A\\nTUNARA_CODEX_SEMANTIC_B/);
  for (const stage of ["slash-menu", "slash-filter", "slash-cancel", "history", "history-cancel", "multiline", "multiline-cancel"]) {
    assert.match(probe, new RegExp(`capture ${stage.replaceAll("-", "\\-")}`));
  }
});

test("Codex semantics summary requires menu, history, multiline, cancel, and normal exit", () => {
  for (const check of ["slashMenuOpened", "slashMenuFiltered", "slashMenuCancelled", "historySearchOpened", "historySearchCancelled", "multilineCancelled", "normalExitObserved"]) {
    assert.match(summary, new RegExp(`"${check}"`));
  }
  assert.match(summary, /"hookTrustGranted": False/);
  assert.match(summary, /def has_menu_candidate/);
  assert.match(summary, /def composer_contains/);
  assert.match(summary, /cleanup\(args\.prefix\)/);
  assert.match(summary, /"passed": all\(checks\.values\(\)\)/);
});
