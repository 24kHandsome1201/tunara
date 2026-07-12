import assert from "node:assert/strict";
import test from "node:test";

import {
  detectPreviewSources,
  createPreviewOutputScanner,
  MAX_PREVIEW_SOURCES_PER_SESSION,
  markPreviewSourcesStale,
  mergePreviewSources,
  normalizePreviewCandidate,
  previewSourceContext,
} from "../src/modules/preview/preview-source.ts";
import { toPersistedSession } from "../src/state/persist-snapshot.ts";

function session(id, worktreeId, port = 3000, remote = undefined) {
  return {
    id,
    dir: `/repo/${worktreeId}`,
    ptyId: port,
    remote,
    workspace: {
      repository: { id: "repo-1", name: "repo", commonGitDir: "/repo/.git", transport: remote ? "ssh" : "local", bare: false },
      currentWorktreeId: worktreeId,
      worktrees: [{ id: worktreeId, name: worktreeId, path: `/repo/${worktreeId}`, detached: false, current: true, locked: false, available: true }],
    },
  };
}

test("两个 worktree 的不同端口保持独立来源身份", () => {
  const a = detectPreviewSources("ready http://localhost:3000", previewSourceContext(session("s-a", "wt-a")), 10)[0];
  const b = detectPreviewSources("ready http://localhost:4000", previewSourceContext(session("s-b", "wt-b")), 20)[0];
  assert.equal(a.worktreeId, "wt-a");
  assert.equal(b.worktreeId, "wt-b");
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.notEqual(a.sourceUrl, b.sourceUrl);
});

test("相同 URL 来自不同 worktree/session 时不会被去重混淆", () => {
  const a = detectPreviewSources("http://127.0.0.1:5173/app", previewSourceContext(session("s-a", "wt-a")), 10);
  const b = detectPreviewSources("http://127.0.0.1:5173/app", previewSourceContext(session("s-b", "wt-b")), 20);
  const merged = mergePreviewSources(a, b);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.sessionId), ["s-a", "s-b"]);
});

test("重复输出按完整来源身份和规范 URL 去重并保留首次发现时间", () => {
  const context = previewSourceContext(session("s-a", "wt-a"));
  const first = detectPreviewSources("http://localhost:3000/x?q=1#ok http://localhost:3000/x?q=1#ok", context, 10);
  const repeat = detectPreviewSources("again http://localhost:3000/x?q=1#ok", context, 20);
  const merged = mergePreviewSources(first, repeat);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].discoveredAt, 10);
  assert.equal(merged[0].sourceUrl, "http://localhost:3000/x?q=1#ok");
});

test("只接受明确 loopback HTTP(S)，处理 IPv6、query/fragment 与尾随标点", () => {
  const context = previewSourceContext(session("s-a", "wt-a"));
  const sources = detectPreviewSources(
    "(http://localhost:3000/a?q=1#f), https://127.0.0.1:4443/x! http://[::1]:8080/v?x=1#z. https://example.com/ http://localhost:70000 ftp://localhost:21",
    context,
    10,
  );
  assert.deepEqual(sources.map((item) => item.sourceUrl), [
    "http://localhost:3000/a?q=1#f",
    "https://127.0.0.1:4443/x",
    "http://[::1]:8080/v?x=1#z",
  ]);
  assert.equal(normalizePreviewCandidate("javascript:alert(1)"), null);
  assert.equal(normalizePreviewCandidate("http://user:pass@localhost:3000"), null);
});

test("SSH localhost 只记录 remote source，不自动获得直连权限", () => {
  const remote = { host: "dev.example", port: 22, user: "mawei" };
  const source = detectPreviewSources("http://localhost:3000", previewSourceContext(session("s-ssh", "wt-ssh", 9, remote)), 10)[0];
  assert.equal(source.transport, "ssh");
  assert.equal(source.permission, "remote-manual");
  assert.match(source.repositoryId, /^repo-1$/);
});

test("终端关闭后保留可解释 stale/source 状态", () => {
  const source = detectPreviewSources("http://localhost:3000", previewSourceContext(session("s-a", "wt-a")), 10)[0];
  const stale = markPreviewSourcesStale([source], source.terminalId);
  assert.equal(stale[0].state, "stale");
  assert.equal(stale[0].staleReason, "terminal-exited");
  assert.equal(stale[0].sourceUrl, source.sourceUrl);
  assert.equal(stale[0].sessionId, "s-a");
});

test("workspace 未完成 hydration 时仍使用 transport/authority/cwd fallback，避免来源合并", () => {
  const local = previewSourceContext({ id: "s-a", dir: "/repo/a" });
  const remote = previewSourceContext({ id: "s-b", dir: "/repo/a", remote: { host: "dev", port: 22, user: "u" } });
  assert.equal(local.workspaceResolution, "fallback");
  assert.equal(remote.workspaceResolution, "fallback");
  assert.notEqual(local.workspaceId, remote.workspaceId);
});

test("previewSources 明确保持 runtime-only，不进入 workspace session snapshot", () => {
  const runtimeSession = {
    ...session("s-a", "wt-a"),
    title: "Terminal",
    branch: "main",
    runState: "idle",
    updatedAt: 10,
    previewSources: detectPreviewSources(
      "http://localhost:3000 ",
      previewSourceContext(session("s-a", "wt-a")),
      10,
    ),
  };
  const persisted = toPersistedSession(runtimeSession);
  assert.equal(Object.hasOwn(persisted, "previewSources"), false);
  assert.deepEqual(Object.keys(persisted).sort(), ["branch", "dir", "id", "title", "updatedAt"]);
});

test("output scanner 对已完成文本只处理一次，并保留跨 chunk URL", () => {
  const outputs = [];
  const scanner = createPreviewOutputScanner((text) => outputs.push(text));
  const encoder = new TextEncoder();
  scanner.push(encoder.encode("prefix http://local"));
  scanner.push(encoder.encode("host:5173/a?q=1"));
  assert.deepEqual(outputs, ["prefix "]);
  scanner.push(encoder.encode("#frag\nnext "));
  scanner.dispose();
  assert.deepEqual(outputs, ["prefix ", "http://localhost:5173/a?q=1#frag\nnext "]);
  assert.equal(outputs.join("").split("prefix").length - 1, 1);
  assert.equal(outputs.join("").split("http://localhost:5173/a?q=1#frag").length - 1, 1);
});

test("output scanner 的 UTF-8 字节分片不丢失且工作量与已完成输入线性有界", () => {
  const outputs = [];
  const scanner = createPreviewOutputScanner((text) => outputs.push(text));
  const bytes = new TextEncoder().encode("中文 http://[::1]:8080/路径?q=一#片段\n");
  for (const byte of bytes) scanner.push(Uint8Array.of(byte));
  scanner.dispose();
  assert.equal(outputs.join(""), "中文 http://[::1]:8080/路径?q=一#片段\n");
  assert.ok(outputs.reduce((sum, text) => sum + text.length, 0) <= new TextDecoder().decode(bytes).length);
  const source = detectPreviewSources(outputs.join(""), previewSourceContext(session("s-a", "wt-a")), 10)[0];
  assert.equal(source.sourceUrl, "http://[::1]:8080/%E8%B7%AF%E5%BE%84?q=%E4%B8%80#%E7%89%87%E6%AE%B5");
});

test("output scanner 对异常长无边界输出保持 4 KiB 内存界且不重放历史", () => {
  const outputs = [];
  const scanner = createPreviewOutputScanner((text) => outputs.push(text));
  const chunk = new TextEncoder().encode("x".repeat(1024));
  for (let index = 0; index < 20; index += 1) scanner.push(chunk);
  assert.deepEqual(outputs, []);
  scanner.push(new TextEncoder().encode("\nready http://localhost:3000\n"));
  scanner.dispose();
  assert.equal(outputs.length, 1);
  assert.ok(outputs[0].length <= 4096 + "\nready http://localhost:3000\n".length);
  assert.equal(outputs[0].split("ready").length - 1, 1);
});

test("每个 session 的 runtime 候选集合有固定上限", () => {
  const context = previewSourceContext(session("s-a", "wt-a"));
  const sources = Array.from({ length: MAX_PREVIEW_SOURCES_PER_SESSION + 10 }, (_, index) =>
    detectPreviewSources(`http://localhost:${3000 + index}/`, context, index)[0]);
  const merged = mergePreviewSources([], sources);
  assert.equal(merged.length, MAX_PREVIEW_SOURCES_PER_SESSION);
  assert.equal(merged[0].sourceUrl, "http://localhost:3010/");
});
