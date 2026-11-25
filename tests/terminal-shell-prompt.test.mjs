import assert from "node:assert/strict";
import test from "node:test";
import { createShellPromptTracker } from "../src/modules/terminal/lib/terminal-shell-prompt.ts";

test("an unbracketed paste ending in Enter accepts the next prompt", () => {
  const prompt = createShellPromptTracker();
  prompt.recordMarker("A");
  prompt.recordInput("echo one\r", false);
  assert.equal(prompt.isFresh(), false);
  prompt.recordMarker("C");
  prompt.recordMarker("D");
  prompt.recordMarker("A");
  assert.equal(prompt.isFresh(), true);
});

test("partial and bracketed pastes stay dirty until input is canceled", () => {
  for (const [data, bracketed] of [
    ["echo one\recho two", false],
    ["echo one\recho two\r", false],
    ["echo one\r", true],
    ["\x1b[200~echo one\r\x1b[201~", false],
  ]) {
    const prompt = createShellPromptTracker();
    prompt.recordMarker("A");
    prompt.recordInput(data, bracketed);
    prompt.recordMarker("A");
    assert.equal(prompt.isFresh(), false);
    prompt.recordInput("\x03", false);
    prompt.recordMarker("A");
    assert.equal(prompt.isFresh(), true);
  }
});
