import assert from "node:assert/strict";
import test from "node:test";

// SSH client logic that can be exercised without a real SSH server:
//   - failure-reason classification (pure substring bucketing)
//   - host profile snake_case ↔ camelCase boundary (hosts-model)
//   - one-shot in-memory credentials (pending-credentials): consumed once,
//     never persisted, security-critical
//
// The actual SSH transport (russh connect/auth, SFTP, known_hosts TOFU) is
// Rust-side and covered by `cargo test`; these tests guard the frontend
// bridges that sit between the Tauri IPC boundary and the UI.

import { classifySshFailure } from "../src/modules/ssh/failure-reason.ts";
import {
  toProfile,
  toRaw,
  makeHostId,
} from "../src/modules/ssh/hosts-model.ts";
import {
  stashSshCredentials,
  takeSshCredentials,
} from "../src/modules/ssh/pending-credentials.ts";

// ── failure-reason ───────────────────────────────────────────────────────

test("classifySshFailure buckets auth errors", () => {
  assert.equal(classifySshFailure("authentication failed: bad password"), "auth");
  assert.equal(classifySshFailure("Auth method rejected"), "auth");
});

test("classifySshFailure buckets host-key errors including the kebab form", () => {
  assert.equal(classifySshFailure("host key mismatch for example.com"), "hostKey");
  assert.equal(classifySshFailure("host-key MISMATCH — refusing"), "hostKey");
  assert.equal(classifySshFailure("server key MISMATCH"), "hostKey");
});

test("classifySshFailure buckets connection errors", () => {
  assert.equal(classifySshFailure("connect 10.0.0.1:22 failed: connection refused"), "connect");
  assert.equal(classifySshFailure("operation timed out"), "connect");
  assert.equal(classifySshFailure("Connection refused"), "connect");
});

test("classifySshFailure falls back to generic for unknown errors", () => {
  assert.equal(classifySshFailure("something unexpected happened"), "generic");
  assert.equal(classifySshFailure(""), "generic");
});

test("classifySshFailure is case-insensitive", () => {
  assert.equal(classifySshFailure("AUTHENTICATION FAILED"), "auth");
  assert.equal(classifySshFailure("TIMED OUT"), "connect");
});

// ── hosts-model: case boundary ───────────────────────────────────────────

test("toProfile converts snake_case identity_file to camelCase identityFile", () => {
  const profile = toProfile({
    id: "h1",
    label: "prod",
    host: "example.com",
    port: 2222,
    user: "deploy",
    identity_file: "~/.ssh/id_ed25519",
  });
  assert.equal(profile.identityFile, "~/.ssh/id_ed25519");
  assert.equal(profile.host, "example.com");
  assert.equal(profile.port, 2222);
});

test("toRaw converts camelCase identityFile back to snake_case identity_file", () => {
  const raw = toRaw({
    id: "h1",
    label: "prod",
    host: "example.com",
    port: 22,
    user: "deploy",
    identityFile: "",
  });
  assert.equal(raw.identity_file, "");
  assert.equal(raw.user, "deploy");
});

test("toProfile and toRaw are inverses (round-trip preserves all fields)", () => {
  const original = {
    id: "host-abc",
    label: "staging box",
    host: "10.0.0.5",
    port: 22,
    user: "root",
    identityFile: "~/.ssh/id_rsa",
  };
  const roundTripped = toProfile(toRaw(original));
  assert.deepEqual(roundTripped, original);
});

test("toProfile preserves an empty identity_file (agent-only auth)", () => {
  const profile = toProfile({
    id: "h2",
    label: "",
    host: "bastion",
    port: 22,
    user: "mwei",
    identity_file: "",
  });
  assert.equal(profile.identityFile, "");
  assert.equal(profile.label, "");
});

test("makeHostId produces a host- prefixed unique-looking id", () => {
  const id = makeHostId();
  assert.match(id, /^host-\d+-\d+$/);
  // Two calls in quick succession should differ (counter + random).
  const id2 = makeHostId();
  assert.notEqual(id, id2);
});

// ── pending-credentials: one-shot, in-memory, never persisted ────────────

test("takeSshCredentials returns stashed credentials and removes them (one-shot)", () => {
  stashSshCredentials("s1", { password: "hunter2" });
  const first = takeSshCredentials("s1");
  assert.equal(first?.password, "hunter2");
  // Second take must be undefined — credentials are consumed on first read.
  const second = takeSshCredentials("s1");
  assert.equal(second, undefined);
});

test("takeSshCredentials returns undefined for a session with no stashed creds", () => {
  assert.equal(takeSshCredentials("never-stashed"), undefined);
});

test("stashSshCredentials with no secrets stores nothing (no empty entry)", () => {
  stashSshCredentials("s2", {});
  assert.equal(takeSshCredentials("s2"), undefined);
});

test("stashSshCredentials with only a key passphrase is retained and consumed once", () => {
  stashSshCredentials("s3", { keyPassphrase: "secret" });
  const first = takeSshCredentials("s3");
  assert.equal(first?.keyPassphrase, "secret");
  assert.equal(takeSshCredentials("s3"), undefined);
});

test("credentials for different sessions are independent", () => {
  stashSshCredentials("a", { password: "pw-a" });
  stashSshCredentials("b", { password: "pw-b" });
  assert.equal(takeSshCredentials("a")?.password, "pw-a");
  assert.equal(takeSshCredentials("b")?.password, "pw-b");
  // Consuming one does not affect the other's second read (both are one-shot).
  assert.equal(takeSshCredentials("a"), undefined);
  assert.equal(takeSshCredentials("b"), undefined);
});
