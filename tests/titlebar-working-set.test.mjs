import assert from "node:assert/strict";
import test from "node:test";

import { sidebarGroupKey } from "../src/modules/session/sidebar-groups.ts";
import {
  cycleTitlebarItems,
  filesOnSameDevice,
  focusTitlebarDeviceSessionId,
  titlebarDeviceKey,
  titlebarWorkingSet,
  titlebarWorkingSetVisible,
  visibleTitlebarItems,
} from "../src/modules/session/titlebar-working-set.ts";

function local(id, dir, patch = {}) {
  return { id, title: id, dir, branch: "", runState: "idle", updatedAt: 1, ...patch };
}

function remote(id, dir, endpoint, patch = {}) {
  return local(id, dir, { remote: { port: 22, ...endpoint }, ...patch });
}

function fileTab(sessionId, filePath, patch = {}) {
  const fileName = filePath.split("/").filter(Boolean).pop() ?? filePath;
  return { id: `${sessionId}\0${filePath}`, sessionId, filePath, fileName, dirty: false, ...patch };
}

test("titlebarDeviceKey reuses the sidebar group key", () => {
  const ssh = remote("b", "/tmp", { user: "deploy", host: "box" });
  assert.equal(titlebarDeviceKey(local("a", "/tmp")), sidebarGroupKey(local("a", "/tmp")));
  assert.equal(titlebarDeviceKey(ssh), sidebarGroupKey(ssh));
});

test("local /tmp and SSH /tmp files never share a working set", () => {
  const localSession = local("local-1", "/tmp");
  const sshSession = remote("ssh-1", "/tmp", { user: "tuna", host: "pi" });
  const fileTabs = [
    fileTab(localSession.id, "/tmp/a.txt"),
    fileTab(sshSession.id, "/tmp/a.txt"),
  ];
  const localSet = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs,
    activeSessionId: localSession.id,
    sidebarVisible: true,
  });
  const sshSet = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs,
    activeSessionId: sshSession.id,
    sidebarVisible: true,
  });
  assert.deepEqual(localSet.files.map((tab) => tab.sessionId), [localSession.id]);
  assert.deepEqual(sshSet.files.map((tab) => tab.sessionId), [sshSession.id]);
  assert.equal(localSet.deviceKind, "local");
  assert.equal(sshSet.deviceKind, "ssh");
  assert.equal(sshSet.deviceLabel, "tuna@pi");
});

test("same README.md on two hosts stay in separate working sets", () => {
  const one = remote("a", "/root", { user: "root", host: "one" });
  const two = remote("b", "/root", { user: "root", host: "two" });
  const fileTabs = [
    fileTab(one.id, "/root/README.md"),
    fileTab(two.id, "/root/README.md"),
  ];
  const focused = titlebarWorkingSet({
    sessions: [one, two],
    fileTabs,
    activeSessionId: one.id,
    sidebarVisible: true,
  });
  assert.deepEqual(focused.files.map((tab) => tab.id), [`${one.id}\0/root/README.md`]);
  assert.equal(focused.files[0]?.fileName, "README.md");
});

test("OSC 7 cwd change keeps an SSH file on the original device", () => {
  const before = remote("s", "deploy@box", { user: "deploy", host: "box" });
  const after = remote("s", "/var/www", { user: "deploy", host: "box" });
  const fileTabs = [fileTab("s", "/etc/hosts")];
  const working = titlebarWorkingSet({
    sessions: [after],
    fileTabs,
    activeSessionId: "s",
    sidebarVisible: true,
  });
  assert.equal(sidebarGroupKey(before), sidebarGroupKey(after));
  assert.equal(working.deviceKey, sidebarGroupKey(after));
  assert.deepEqual(working.files.map((tab) => tab.filePath), ["/etc/hosts"]);
});

test("sidebar open hides terminal tabs and only shows current-device files", () => {
  const localSession = local("local-1", "/tmp/app");
  const sshSession = remote("ssh-1", "/srv", { user: "tuna", host: "pi" });
  const working = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs: [
      fileTab(localSession.id, "/tmp/app/notes.txt"),
      fileTab(sshSession.id, "/srv/hosts"),
    ],
    activeSessionId: sshSession.id,
    sidebarVisible: true,
  });
  assert.equal(working.showTerminals, false);
  assert.deepEqual(visibleTitlebarItems(working).map((item) => item.kind), ["file"]);
  assert.deepEqual(working.files.map((tab) => tab.fileName), ["hosts"]);
  assert.equal(titlebarWorkingSetVisible(working), true);
});

test("sidebar collapsed shows only the current device terminals", () => {
  const localA = local("a", "/tmp/app");
  const localB = local("b", "/tmp/app");
  const ssh = remote("c", "/srv", { user: "tuna", host: "pi" });
  const working = titlebarWorkingSet({
    sessions: [localA, localB, ssh],
    fileTabs: [fileTab(ssh.id, "/srv/hosts")],
    activeSessionId: localA.id,
    sidebarVisible: false,
  });
  assert.equal(working.showTerminals, true);
  assert.deepEqual(working.terminals.map((session) => session.id), ["a", "b"]);
  assert.deepEqual(working.files, []);
  assert.deepEqual(visibleTitlebarItems(working).map((item) => item.id), ["a", "b"]);
  assert.equal(working.showDeviceMenu, true);
  assert.equal(working.showOriginGlyph, false);
});

test("switching the active session changes visible files without dropping hidden tabs", () => {
  const localSession = local("local-1", "/tmp");
  const sshSession = remote("ssh-1", "/tmp", { user: "tuna", host: "pi" });
  const fileTabs = [
    fileTab(localSession.id, "/tmp/a.txt"),
    fileTab(sshSession.id, "/tmp/a.txt"),
  ];
  const first = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs,
    activeSessionId: localSession.id,
    sidebarVisible: true,
  });
  const second = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs,
    activeSessionId: sshSession.id,
    sidebarVisible: true,
  });
  assert.equal(fileTabs.length, 2);
  assert.deepEqual(first.files.map((tab) => tab.sessionId), [localSession.id]);
  assert.deepEqual(second.files.map((tab) => tab.sessionId), [sshSession.id]);
});

test("a single-device window does not show the device menu", () => {
  const session = local("a", "/tmp/app");
  const working = titlebarWorkingSet({
    sessions: [session],
    fileTabs: [fileTab(session.id, "/tmp/app/notes.txt")],
    activeSessionId: session.id,
    sidebarVisible: false,
  });
  assert.equal(working.showDeviceMenu, false);
  assert.equal(working.showOriginGlyph, true);
  assert.equal(working.foreignDirtyCount, 0);
});

test("a collapsed single-SSH window exposes identity and connection state without a device menu", () => {
  const session = remote("ssh-1", "/srv", { user: "tuna", host: "pi" }, { connection: { phase: "ready" } });
  const working = titlebarWorkingSet({
    sessions: [session],
    fileTabs: [],
    activeSessionId: session.id,
    sidebarVisible: false,
  });
  assert.equal(working.showDeviceMenu, false);
  assert.equal(working.showDeviceIdentity, true);
  assert.equal(working.deviceConnectionPhase, "ready");
  assert.equal(working.showOriginGlyph, false);
});

test("foreign dirty files stay off the current strip and surface on the device menu", () => {
  const localSession = local("local-1", "/tmp/app");
  const sshSession = remote("ssh-1", "/srv", { user: "alice", host: "prod", port: 2222 });
  const fileTabs = [
    fileTab(localSession.id, "/tmp/app/notes.txt"),
    fileTab(sshSession.id, "/srv/README.md", { dirty: true }),
  ];
  const working = titlebarWorkingSet({
    sessions: [localSession, sshSession],
    fileTabs,
    activeSessionId: localSession.id,
    sidebarVisible: false,
  });
  assert.equal(working.foreignDirtyCount, 1);
  assert.deepEqual(working.foreignDirtyFiles.map((item) => item.tab.fileName), ["README.md"]);
  assert.equal(working.foreignDirtyFiles[0]?.device.label, "alice@prod:2222");
  assert.deepEqual(working.files.map((tab) => tab.fileName), ["notes.txt"]);
});

test("host:22 and host:2222 stay distinct devices", () => {
  const a = remote("a", "/root", { user: "root", host: "box", port: 22 });
  const b = remote("b", "/root", { user: "root", host: "box", port: 2222 });
  const working = titlebarWorkingSet({
    sessions: [a, b],
    fileTabs: [fileTab(a.id, "/root/a.txt"), fileTab(b.id, "/root/b.txt")],
    activeSessionId: a.id,
    sidebarVisible: true,
  });
  assert.equal(working.deviceKey, "ssh:root@box:22");
  assert.deepEqual(working.files.map((tab) => tab.fileName), ["a.txt"]);
});

test("prototype-like local dirs remain ordinary device keys", () => {
  const session = local("proto", "__proto__");
  const working = titlebarWorkingSet({
    sessions: [session],
    fileTabs: [fileTab(session.id, "__proto__/notes.txt")],
    activeSessionId: session.id,
    sidebarVisible: true,
  });
  assert.equal(working.deviceKey, "local:__proto__");
  assert.equal(working.deviceLabel, "__proto__");
});

test("local device label prefers the repository name", () => {
  const session = local("a", "/Users/me/src/tunara", {
    workspace: { repository: { name: "tunara", commonGitDir: "/x", transport: "local", bare: false, id: "r" }, worktrees: [] },
  });
  const working = titlebarWorkingSet({
    sessions: [session],
    fileTabs: [],
    activeSessionId: session.id,
    sidebarVisible: false,
  });
  assert.equal(working.deviceLabel, "tunara");
  assert.equal(working.deviceDetail, "/Users/me/src/tunara");
});

test("cycle order keeps hidden terminals so Mod+Tab can leave a file", () => {
  const session = local("a", "/tmp/app");
  const working = titlebarWorkingSet({
    sessions: [session],
    fileTabs: [fileTab(session.id, "/tmp/app/notes.txt")],
    activeSessionId: session.id,
    sidebarVisible: true,
  });
  assert.deepEqual(visibleTitlebarItems(working).map((item) => item.kind), ["file"]);
  assert.deepEqual(cycleTitlebarItems(working).map((item) => item.kind), ["terminal", "file"]);
});

test("filesOnSameDevice ignores a sibling on another host", () => {
  const localSession = local("local-1", "/tmp");
  const sshSession = remote("ssh-1", "/tmp", { user: "tuna", host: "pi" });
  const fileTabs = [
    fileTab(localSession.id, "/tmp/a.txt"),
    fileTab(sshSession.id, "/tmp/a.txt"),
    fileTab(localSession.id, "/tmp/b.txt"),
  ];
  const siblings = filesOnSameDevice(fileTabs[0], fileTabs, [localSession, sshSession]);
  assert.deepEqual(siblings.map((tab) => tab.fileName), ["a.txt", "b.txt"]);
});

test("focusTitlebarDeviceSessionId prefers the active session then latest update", () => {
  const older = remote("old", "/srv", { user: "tuna", host: "pi" }, { updatedAt: 1 });
  const newer = remote("new", "/var", { user: "tuna", host: "pi" }, { updatedAt: 9 });
  const key = sidebarGroupKey(newer);
  assert.equal(focusTitlebarDeviceSessionId(key, [older, newer], "old"), "old");
  assert.equal(focusTitlebarDeviceSessionId(key, [older, newer], "missing"), "new");
});
