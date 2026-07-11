import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summarizer = resolve(root, "scripts/summarize-agent-session.py");

const resumeCases = [
  ["resume-local-claude", "session_id", "11111111-1111-4111-8111-111111111111", "TUNARA_CLAUDE_FIRST_OK", "TUNARA_CLAUDE_RESUME_OK"],
  ["resume-local-codex", "thread_id", "22222222-2222-4222-8222-222222222222", "TUNARA_CODEX_FIRST_OK", "TUNARA_CODEX_RESUME_OK"],
  ["resume-ssh-codex", "thread_id", "33333333-3333-4333-8333-333333333333", "TUNARA_SSH_CODEX_FIRST_OK", "TUNARA_SSH_CODEX_RESUME_OK"],
];

function writeResumeFixtures(dir) {
  for (const [name, idKey, id, firstMarker, resumeMarker] of resumeCases) {
    writeFileSync(join(dir, `${name}-first.log`), `${JSON.stringify({ [idKey]: id, result: firstMarker })}\n`);
    writeFileSync(join(dir, `${name}-resume.log`), `${JSON.stringify({ [idKey]: id, result: resumeMarker })}\n`);
  }
}

function summarize(dir, output) {
  const run = spawnSync("python3", [
    summarizer,
    "--input", dir,
    "--output", output,
    "--commit", "test-commit",
    "--target", "test-host",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(output, "utf8"));
}

test("agent session summary recognizes compact TUI prompts and explicit resume IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-agent-session-summary-"));
  try {
    writeResumeFixtures(dir);
    writeFileSync(join(dir, "permission-claude.log"), "\u001b[2mDo  you want\n to proceed? Esc to cancel\u001b[0m");
    writeFileSync(join(dir, "permission-codex.log"), "Do you trust the contents of this directory?\nHigher risk of prompt injection");
    writeFileSync(join(dir, "permission-claude-probe-created"), "0\n");

    const result = summarize(dir, join(dir, "result.json"));
    assert.equal(result.commit, "test-commit");
    assert.equal(result.sshTarget, "test-host");
    assert.equal(result.permission.localClaude.toolPermissionPromptObserved, true);
    assert.equal(result.permission.localClaude.temporaryProbeCreated, false);
    assert.equal(result.permission.localClaude.result, "prompt_observed");
    assert.equal(result.permission.localCodex.directoryTrustPromptObserved, true);
    assert.equal(result.permission.localCodex.promptInjectionRiskCopyObserved, true);
    assert.equal(result.permission.localCodex.result, "prompt_observed");
    assert.deepEqual(result.summary, {
      permissionPromptsObserved: 2,
      resumePassed: 3,
      resumeEntries: 3,
    });
    for (const entry of Object.values(result.resume)) {
      assert.equal(entry.idObserved, true);
      assert.equal(entry.firstMarkerObserved, true);
      assert.equal(entry.resumeMarkerObserved, true);
      assert.equal(entry.passed, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent session summary does not relabel organization-policy auto-allow as a prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-agent-session-auto-allow-"));
  try {
    writeResumeFixtures(dir);
    writeFileSync(join(dir, "permission-claude.log"), "tool completed without confirmation");
    writeFileSync(join(dir, "permission-codex.log"), "startup interrupted before trust choice");
    writeFileSync(join(dir, "permission-claude-probe-created"), "1\n");

    const result = summarize(dir, join(dir, "result.json"));
    assert.equal(result.permission.localClaude.toolPermissionPromptObserved, false);
    assert.equal(result.permission.localClaude.temporaryProbeCreated, true);
    assert.equal(result.permission.localClaude.result, "organization_policy_auto_allowed");
    assert.equal(result.permission.localCodex.directoryTrustPromptObserved, false);
    assert.equal(result.permission.localCodex.result, "prompt_missing");
    assert.equal(result.summary.permissionPromptsObserved, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
