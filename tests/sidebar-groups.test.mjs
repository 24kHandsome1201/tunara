import assert from "node:assert/strict";
import test from "node:test";

import {
  groupSessionsForSidebar,
  knownRemoteCwd,
  liveSessionsOnEndpoint,
  representativeSession,
  sessionMatchesSidebarSearch,
  sidebarCwdLabel,
  sidebarGroupKey,
  sidebarGroupKeyFromEndpoint,
  sshCardConnectionPhase,
  sshConnectionPhaseTone,
  sshEndpointLabel,
} from "../src/modules/session/sidebar-groups.ts";

function local(id, dir, patch = {}) {
  return { id, title: id, dir, branch: "", runState: "idle", updatedAt: 1, ...patch };
}

function remote(id, dir, endpoint, patch = {}) {
  return local(id, dir, { remote: { port: 22, ...endpoint }, ...patch });
}

test("sidebarGroupKey isolates local and SSH sessions that share a path string", () => {
  assert.equal(sidebarGroupKey(local("a", "/tmp")), "local:/tmp");
  assert.equal(
    sidebarGroupKey(remote("b", "/tmp", { user: "deploy", host: "box" })),
    "ssh:deploy@box:22",
  );
});

test("sidebarGroupKey keeps one SSH host together across OSC 7 cwd changes", () => {
  const before = remote("s", "deploy@box", { user: "deploy", host: "box" });
  const after = remote("s", "/var/www", { user: "deploy", host: "box" });
  assert.equal(sidebarGroupKey(before), sidebarGroupKey(after));
});

test("sidebarGroupKey treats host case as the same machine and keeps ports distinct", () => {
  assert.equal(
    sidebarGroupKey(remote("a", "/root", { user: "root", host: "Prod.Example" })),
    sidebarGroupKeyFromEndpoint({ user: "root", host: "prod.example", port: 22 }),
  );
  assert.notEqual(
    sidebarGroupKey(remote("a", "/root", { user: "root", host: "box", port: 22 })),
    sidebarGroupKey(remote("b", "/root", { user: "root", host: "box", port: 2222 })),
  );
});

test("groupSessionsForSidebar does not merge two hosts that share /root", () => {
  const groups = groupSessionsForSidebar([
    remote("a", "/root", { user: "root", host: "one" }),
    remote("b", "/root", { user: "root", host: "two" }),
    local("c", "/root"),
  ]);
  assert.deepEqual(groups.map((group) => group.key), [
    "ssh:root@one:22",
    "ssh:root@two:22",
    "local:/root",
  ]);
  assert.deepEqual(groups.map((group) => group.kind), ["ssh", "ssh", "local"]);
});

test("groupSessionsForSidebar preserves insertion order and prototype-like local dirs", () => {
  const groups = groupSessionsForSidebar([
    local("proto", "__proto__"),
    local("ctor", "constructor"),
    local("again", "__proto__"),
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["local:__proto__", "local:constructor"]);
  assert.deepEqual(groups[0].sessions.map((session) => session.id), ["proto", "again"]);
});

test("groupSessionsForSidebar returns no groups for an empty list", () => {
  assert.deepEqual(groupSessionsForSidebar([]), []);
});

test("sessionMatchesSidebarSearch finds SSH hosts after cwd becomes a path", () => {
  const session = remote("s", "/var/www", { user: "alice", host: "prod.internal", port: 2222 });
  assert.equal(sessionMatchesSidebarSearch(session, "prod"), true);
  assert.equal(sessionMatchesSidebarSearch(session, "alice@prod.internal:2222"), true);
  assert.equal(sessionMatchesSidebarSearch(session, "www"), true);
  assert.equal(sessionMatchesSidebarSearch(session, "nope"), false);
});

test("sidebarCwdLabel uses basename for remote POSIX cwd and keeps user@host before OSC 7", () => {
  assert.equal(sidebarCwdLabel(local("a", "/Users/me/project")), "project");
  assert.equal(sidebarCwdLabel(remote("b", "deploy@box", { user: "deploy", host: "box" })), "deploy@box");
  assert.equal(sidebarCwdLabel(remote("c", "/var/www", { user: "deploy", host: "box" })), "www");
  assert.equal(knownRemoteCwd("deploy@box"), null);
  assert.equal(knownRemoteCwd("/var/www"), "/var/www");
});

test("sshEndpointLabel omits port 22", () => {
  assert.equal(sshEndpointLabel({ user: "a", host: "h", port: 22 }), "a@h");
  assert.equal(sshEndpointLabel({ user: "a", host: "h", port: 2222 }), "a@h:2222");
});

test("representativeSession prefers the active session then the latest update", () => {
  const sessions = [
    local("old", "/tmp", { updatedAt: 1 }),
    local("new", "/tmp", { updatedAt: 9 }),
  ];
  assert.equal(representativeSession(sessions, "old")?.id, "old");
  assert.equal(representativeSession(sessions, "missing")?.id, "new");
});

test("liveSessionsOnEndpoint matches the sidebar host key, not cwd", () => {
  const sessions = [
    remote("a", "/tmp", { user: "deploy", host: "box" }),
    remote("b", "/var/www", { user: "deploy", host: "box" }),
    remote("c", "/tmp", { user: "deploy", host: "other" }),
    local("d", "/tmp"),
  ];
  assert.deepEqual(
    liveSessionsOnEndpoint(sessions, { user: "deploy", host: "box", port: 22 }).map((session) => session.id),
    ["a", "b"],
  );
});

test("sshCardConnectionPhase stays quiet while ready and never invents local phases", () => {
  assert.equal(sshCardConnectionPhase(local("a", "/tmp")), null);
  assert.equal(
    sshCardConnectionPhase(remote("b", "/tmp", { user: "a", host: "h" }, {
      connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
    })),
    null,
  );
  assert.equal(
    sshCardConnectionPhase(remote("c", "/tmp", { user: "a", host: "h" }, {
      connection: { transport: "ssh", phase: "connecting", source: "backend", updatedAt: 1 },
    })),
    "connecting",
  );
  assert.equal(sshConnectionPhaseTone("connecting"), "progress");
  assert.equal(sshConnectionPhaseTone("needsUserAction"), "warning");
  assert.equal(sshConnectionPhaseTone("disconnected"), "error");
});
