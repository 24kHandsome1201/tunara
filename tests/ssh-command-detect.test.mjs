import assert from "node:assert/strict";
import test from "node:test";

// detectSshCommand is the trigger for the "open with built-in SSH" suggestion
// bar. It MUST be high-precision / low-recall: a false positive sends the user
// at the wrong host, which is worse than not suggesting at all. These tests pin
// both the accepted shapes and — more importantly — the rejected ones.

import { detectSshCommand } from "../src/modules/terminal/lib/ssh-command-detect.ts";

// ── accepted shapes ──────────────────────────────────────────────────────

test("detectSshCommand: ssh host", () => {
  assert.deepEqual(detectSshCommand("ssh example.com"), { host: "example.com" });
});

test("detectSshCommand: ssh user@host", () => {
  assert.deepEqual(detectSshCommand("ssh root@example.com"), {
    host: "example.com",
    user: "root",
  });
});

test("detectSshCommand: ssh -p PORT user@host", () => {
  assert.deepEqual(detectSshCommand("ssh -p 2222 deploy@10.0.0.5"), {
    host: "10.0.0.5",
    user: "deploy",
    port: 2222,
  });
});

test("detectSshCommand: ssh user@host -p PORT (flag after target)", () => {
  assert.deepEqual(detectSshCommand("ssh deploy@10.0.0.5 -p 2222"), {
    host: "10.0.0.5",
    user: "deploy",
    port: 2222,
  });
});

test("detectSshCommand: ssh -pPORT host (glued port flag)", () => {
  assert.deepEqual(detectSshCommand("ssh -p2222 box"), { host: "box", port: 2222 });
});

test("detectSshCommand: hostnames with dots and hyphens", () => {
  assert.deepEqual(detectSshCommand("ssh my-box.internal.example.com"), {
    host: "my-box.internal.example.com",
  });
});

test("detectSshCommand: tolerates surrounding whitespace", () => {
  assert.deepEqual(detectSshCommand("   ssh host   "), { host: "host" });
});

// ── rejected shapes (must NOT mis-suggest) ───────────────────────────────

test("detectSshCommand: bare ssh → null", () => {
  assert.equal(detectSshCommand("ssh"), null);
});

test("detectSshCommand: empty / blank → null", () => {
  assert.equal(detectSshCommand(""), null);
  assert.equal(detectSshCommand("   "), null);
});

test("detectSshCommand: mosh / et / wrappers → null", () => {
  assert.equal(detectSshCommand("mosh host"), null);
  assert.equal(detectSshCommand("et host"), null);
  assert.equal(detectSshCommand("sshpass -p x ssh host"), null);
  assert.equal(detectSshCommand("kitty +kitten ssh host"), null);
});

test("detectSshCommand: ssh with -o / -i / -L flags → null", () => {
  assert.equal(detectSshCommand("ssh -o StrictHostKeyChecking=no host"), null);
  assert.equal(detectSshCommand("ssh -i ~/.ssh/id_ed25519 host"), null);
  assert.equal(detectSshCommand("ssh -L 8080:localhost:80 host"), null);
  assert.equal(detectSshCommand("ssh -N -D 1080 host"), null);
});

test("detectSshCommand: ssh with a remote command → null", () => {
  assert.equal(detectSshCommand("ssh host ls -la"), null);
  assert.equal(detectSshCommand("ssh host uptime"), null);
});

test("detectSshCommand: shell composition (&&, |, ;, subshell) → null", () => {
  assert.equal(detectSshCommand("cd /tmp && ssh host"), null);
  assert.equal(detectSshCommand("ssh host && echo done"), null);
  assert.equal(detectSshCommand("ssh host | tee log"), null);
  assert.equal(detectSshCommand("ssh host; ls"), null);
  assert.equal(detectSshCommand("echo ssh host"), null);
  assert.equal(detectSshCommand("ssh $(echo host)"), null);
});

test("detectSshCommand: IPv6 bracket target → null (known unsupported)", () => {
  assert.equal(detectSshCommand("ssh user@[::1]"), null);
});

test("detectSshCommand: user:password@host → null (never leak a credential)", () => {
  // The colon is outside USER_RE, so a password-in-URL form is rejected wholesale
  // rather than parsed — the suggestion path must never carry a secret.
  assert.equal(detectSshCommand("ssh user:hunter2@host"), null);
});

test("detectSshCommand: single-char host is accepted", () => {
  assert.deepEqual(detectSshCommand("ssh a"), { host: "a" });
});

test("detectSshCommand: very long input stays linear (no ReDoS)", () => {
  // HOST_RE / USER_RE are anchored and linear; a 50k-char host must not hang.
  const host = "a".repeat(50_000);
  const start = process.hrtime.bigint();
  const result = detectSshCommand("ssh " + host);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.deepEqual(result, { host });
  assert.ok(elapsedMs < 100, `parse took ${elapsedMs}ms, expected < 100ms`);
});

test("detectSshCommand: invalid port → null", () => {
  assert.equal(detectSshCommand("ssh -p 0 host"), null);
  assert.equal(detectSshCommand("ssh -p 99999 host"), null);
  assert.equal(detectSshCommand("ssh -p abc host"), null);
});

test("detectSshCommand: duplicate -p → null", () => {
  assert.equal(detectSshCommand("ssh -p 22 -p 2222 host"), null);
});
