import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const probe = readFileSync(new URL("../scripts/smoke-opencode-semantics.sh", import.meta.url), "utf8");
const summary = readFileSync(new URL("../scripts/summarize-opencode-semantics.py", import.meta.url), "utf8");
const environment = readFileSync(new URL("../scripts/fixtures/opencode-loopback-probe.sh", import.meta.url), "utf8");

test("OpenCode semantics probe captures menu, multiline, failed turn, and history stages", () => {
  assert.match(probe, /caller must bind this probe to a loopback-only provider stub/);
  assert.match(probe, /refusing probe without loopback provider and disabled tools/);
  assert.match(probe, /wait_for_text 'Unauthorized'/);
  assert.match(probe, /send-keys -t "\$session" Up/);
  assert.match(probe, /paste-buffer -p/);
  for (const stage of ["slash-menu", "slash-filter", "slash-cancel", "multiline", "multiline-cancel", "history-failure", "history-up", "history-cancel"]) {
    assert.match(probe, new RegExp(`capture ${stage}`));
  }
});

test("OpenCode probe environment is isolated, loopback-only, tool-free, and self-cleaning", () => {
  assert.match(environment, /HOME="\$runtime\/home"/);
  assert.match(environment, /XDG_CONFIG_HOME="\$runtime\/config"/);
  assert.match(environment, /127\.0\.0\.1/);
  assert.match(environment, /send_response\(401\)/);
  assert.match(environment, /"tools":\{"write":false,"bash":false\}/);
  assert.match(environment, /rm -rf "\$runtime"/);
});

test("OpenCode summary requires loopback failure, history restoration, cancellation, and exit", () => {
  for (const check of ["slashMenuOpened", "slashMenuFiltered", "slashMenuCancelled", "multilineCancelled", "loopbackFailureObserved", "historyRestored", "historyCancelled", "normalExitObserved"]) {
    assert.match(summary, new RegExp(`"${check}"`));
  }
  assert.match(summary, /"externalModelReached": False/);
  assert.match(summary, /"providerEndpoint": "loopback-only HTTP 401 stub"/);
  assert.match(summary, /cleanup\(args\.prefix\)/);
});
