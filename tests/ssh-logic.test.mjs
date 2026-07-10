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
  RemoteOperationCache,
  remoteOperationCacheKey,
} from "../src/modules/ssh/remote-operation-cache.ts";
import {
  toProfile,
  toRaw,
  makeHostId,
  normalizeSshPort,
  parseSshPort,
  filterNewHostsById,
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
  // russh returns this exact text when a first-use prompt is rejected.
  assert.equal(classifySshFailure("SSH handshake failed: Unknown server key"), "hostKey");
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

test("normalizeSshPort accepts only integer TCP port numbers", () => {
  assert.equal(normalizeSshPort("2222"), 2222);
  assert.equal(normalizeSshPort(" 2200 "), 2200);
  assert.equal(normalizeSshPort(2222.9), 22);
  assert.equal(normalizeSshPort("0"), 22);
  assert.equal(normalizeSshPort("65536"), 22);
  assert.equal(normalizeSshPort("22oops"), 22);
  assert.equal(normalizeSshPort("22.5"), 22);
  assert.equal(normalizeSshPort("not-a-port"), 22);
  assert.equal(normalizeSshPort(undefined, 2200), 2200);
  assert.equal(normalizeSshPort(undefined, 70_000), 22);
});

test("parseSshPort validates raw values without applying a fallback", () => {
  assert.equal(parseSshPort("2222"), 2222);
  assert.equal(parseSshPort(" 2200 "), 2200);
  assert.equal(parseSshPort(2222.9), null);
  assert.equal(parseSshPort("0"), null);
  assert.equal(parseSshPort("65536"), null);
  assert.equal(parseSshPort("22oops"), null);
  assert.equal(parseSshPort("22.5"), null);
  assert.equal(parseSshPort(undefined), null);
});

test("host profile conversion normalizes invalid persisted ports", () => {
  const profile = toProfile({
    id: "h-invalid",
    label: "bad",
    host: "example.com",
    port: 70000,
    user: "deploy",
    identity_file: "",
  });
  assert.equal(profile.port, 22);

  const raw = toRaw({ ...profile, port: Number.POSITIVE_INFINITY });
  assert.equal(raw.port, 22);
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

// ── ~/.ssh/config import dedup ───────────────────────────────────────────
// The backend assigns imported profiles a stable `ssh-config-<alias>` id, so
// re-importing the same config must be idempotent: the second pass returns no
// new profiles, preserving any manual identity_file edits the user made.

test("filterNewHostsById returns only profiles not already present", () => {
  const existing = [{ id: "ssh-config-prod", label: "prod", host: "p.example.com", port: 22, user: "deploy", identityFile: "~/.ssh/custom" }];
  const incoming = [
    { id: "ssh-config-prod", label: "prod", host: "p.example.com", port: 22, user: "deploy", identityFile: "~/.ssh/id_prod" },
    { id: "ssh-config-dev", label: "dev", host: "10.0.0.5", port: 22, user: "root", identityFile: "" },
  ];
  const fresh = filterNewHostsById(existing, incoming);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].id, "ssh-config-dev");
});

test("filterNewHostsById returns all when nothing exists", () => {
  const incoming = [
    { id: "ssh-config-a", label: "a", host: "a", port: 22, user: "u", identityFile: "" },
    { id: "ssh-config-b", label: "b", host: "b", port: 22, user: "u", identityFile: "" },
  ];
  assert.equal(filterNewHostsById([], incoming).length, 2);
});

test("remote operation cache keys include kind, limit, and delimiter-safe values", () => {
  assert.notEqual(
    remoteOperationCacheKey("find", 1, "/a|b", "c", 80),
    remoteOperationCacheKey("find", 1, "/a", "b|c", 80),
  );
  assert.notEqual(
    remoteOperationCacheKey("find", 1, "/a", "q", 80),
    remoteOperationCacheKey("grep", 1, "/a", "q", 80),
  );
  assert.notEqual(
    remoteOperationCacheKey("find", 1, "/a", "q", 80),
    remoteOperationCacheKey("find", 1, "/a", "q", 200),
  );
});

test("remote operation cache is bounded, refreshes LRU, and invalidates by session", () => {
  const cache = new RemoteOperationCache(2);
  cache.set("a", 1, "A");
  cache.set("b", 2, "B");
  assert.equal(cache.get("a"), "A"); // a is now newest
  cache.set("c", 1, "C");
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined);
  cache.invalidateSession(1);
  assert.equal(cache.size, 0);
});

test("remote operation cache rejects responses invalidated while in flight", () => {
  const cache = new RemoteOperationCache(2);
  const staleGeneration = cache.sessionGeneration(7);
  cache.invalidateSession(7);
  assert.equal(cache.setIfCurrent("stale", 7, staleGeneration, "old"), false);
  assert.equal(cache.get("stale"), undefined);

  const currentGeneration = cache.sessionGeneration(7);
  assert.equal(cache.setIfCurrent("fresh", 7, currentGeneration, "new"), true);
  assert.equal(cache.get("fresh"), "new");
});
