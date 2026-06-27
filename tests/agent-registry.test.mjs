import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_REGISTRY,
  AGENT_NAMES,
  AGENT_COMMANDS,
  AGENT_CODES,
  AGENT_SHELL_TITLE_FRAGMENTS,
} from "../src/modules/agent/registry.ts";

// The registry is the single source of truth for agent detection. The Rust
// resolver/preflight compile the same registry-data.json via include_str!, so
// these invariants guard the contract both sides depend on.

test("AGENT_REGISTRY has the expected number of agents and unique codes", () => {
  assert.equal(AGENT_REGISTRY.length, 12);
  const codes = AGENT_REGISTRY.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length, "agent codes must be unique");
});

test("every registry entry has a non-empty name, code, cliBin and at least one command", () => {
  for (const entry of AGENT_REGISTRY) {
    assert.ok(entry.code.length > 0, "code");
    assert.ok(entry.name.length > 0, `name for ${entry.code}`);
    assert.ok(entry.cliBin.length > 0, `cliBin for ${entry.code}`);
    assert.ok(entry.commands.length > 0, `commands for ${entry.code}`);
  }
});

test("AGENT_NAMES maps every code to its display name", () => {
  assert.equal(AGENT_NAMES.CC, "Claude Code");
  assert.equal(AGENT_NAMES.CX, "Codex");
  assert.equal(Object.keys(AGENT_NAMES).length, AGENT_REGISTRY.length);
});

test("AGENT_COMMANDS flat-maps every command to a known code", () => {
  assert.equal(AGENT_COMMANDS.claude, "CC");
  assert.equal(AGENT_COMMANDS.codex, "CX");
  assert.equal(AGENT_COMMANDS.ampcode, "AM");
  for (const code of Object.values(AGENT_COMMANDS)) {
    assert.ok(AGENT_CODES.has(code), `${code} must be a known agent code`);
  }
});

test("AGENT_COMMANDS has no duplicate command across agents", () => {
  const commandCount = AGENT_REGISTRY.reduce((n, a) => n + a.commands.length, 0);
  assert.equal(
    Object.keys(AGENT_COMMANDS).length,
    commandCount,
    "two agents must not claim the same command string",
  );
});

test("AGENT_CODES contains exactly the registry codes", () => {
  assert.equal(AGENT_CODES.size, AGENT_REGISTRY.length);
  for (const entry of AGENT_REGISTRY) {
    assert.ok(AGENT_CODES.has(entry.code));
  }
});

test("AGENT_SHELL_TITLE_FRAGMENTS are all lowercased and trimmed", () => {
  for (const fragment of AGENT_SHELL_TITLE_FRAGMENTS) {
    assert.equal(fragment, fragment.toLowerCase(), "lowercased");
    assert.equal(fragment, fragment.trim(), "trimmed");
    assert.ok(fragment.length > 0, "non-empty");
  }
});
