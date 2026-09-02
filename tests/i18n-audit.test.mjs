import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditI18n, parseDynamicPattern } from "../scripts/i18n-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts/i18n-audit.mjs");

function runAudit(args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("dynamic template prefixes keep a leading segment and optional suffix", () => {
  assert.deepEqual(parseDynamicPattern("workspace.${kind}_error.title"), {
    kind: "dynamic",
    leading: "workspace.",
    trailing: "_error.title",
    raw: "workspace.${kind}_error.title",
  });
  assert.deepEqual(parseDynamicPattern("ssh.auth.${method}.label"), {
    kind: "dynamic",
    leading: "ssh.auth.",
    trailing: ".label",
    raw: "ssh.auth.${method}.label",
  });
  assert.deepEqual(parseDynamicPattern("settings.tabs.appearance"), {
    kind: "static",
    key: "settings.tabs.appearance",
  });
});

test("en and zh-CN locale key sets are identical", () => {
  const result = auditI18n(root);
  assert.deepEqual(result.onlyInEn, []);
  assert.deepEqual(result.onlyInZhCN, []);
  assert.equal(result.localeCounts.en, result.localeCounts["zh-CN"]);
});

test("referenced i18n keys exist in the dictionaries", () => {
  const result = auditI18n(root);
  assert.deepEqual(result.missing, [], `missing keys: ${result.missing.join(", ")}`);
});

test("unreferenced keys are reported without failing by default", () => {
  const result = auditI18n(root);
  console.log(`i18n dead keys: ${result.dead.length} (strict mode: I18N_FAIL_ON_DEAD=1)`);
  assert.ok(Array.isArray(result.dead));
  if (process.env.I18N_FAIL_ON_DEAD === "1") {
    assert.equal(result.dead.length, 0, `dead keys remain: ${result.dead.length}`);
  }
});

test("i18n-audit --json emits the three report buckets", () => {
  const proc = runAudit(["--json"]);
  assert.equal(proc.status, 0, proc.stderr);
  const payload = JSON.parse(proc.stdout);
  assert.ok(Array.isArray(payload.dead));
  assert.ok(Array.isArray(payload.missing));
  assert.ok(Array.isArray(payload.onlyInEn));
  assert.ok(Array.isArray(payload.onlyInZhCN));
  assert.ok(Array.isArray(payload.dynamicPrefixes));
});

test("i18n-audit --fail-on-dead exits non-zero when dead keys exist", () => {
  const result = auditI18n(root);
  const proc = runAudit(["--fail-on-dead", "--json"]);
  if (result.dead.length > 0) {
    assert.notEqual(proc.status, 0);
  } else {
    assert.equal(proc.status, 0, proc.stderr);
  }
});
