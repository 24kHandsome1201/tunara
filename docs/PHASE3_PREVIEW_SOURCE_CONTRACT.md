# Phase 3 Workspace-bound Preview：来源绑定与 URL 安全检测基础

## 本批唯一目标

在创建任何浏览器 surface 之前，先让终端输出中的本地开发 URL 成为可解释、不可跨 worktree 混淆的 Preview 候选。候选必须回答：属于哪个 repository、worktree、workspace、session 和 terminal，何时发现，当前来源是否仍存活，以及是否具备本地 Preview 资格。

## 复用点

- URL token 继续复用终端 quick-select 的提取器；本批只扩展它对 IPv6 loopback 与成对尾随标点的处理，不建立第二套通用链接检测器。
- 发现入口复用 `TerminalView` 唯一的 PTY `onData` 输出流，不读取持久 scrollback，也不扫描 DOM。
- repository/worktree 使用 Phase 1 的 `RepositoryRef / WorktreeRef / WorkspaceContext`。workspace hydration 尚未完成时，以 `transport + SSH authority + cwd` 形成明确的 fallback identity，而不是把来源归并到空值。
- 候选是 `Session.previewSources` 的 runtime-only 状态，不进入 workspace snapshot。
- 每个 session 最多保留最近 64 个不同来源候选，避免异常输出制造无界前端状态。

## 最小数据合同

```text
PreviewSource = {
  repositoryId, worktreeId, workspaceId,
  sessionId, terminalId, physicalPtyId?,
  sourceUrl, discoveredAt,
  transport: local | ssh,
  workspaceResolution: resolved | fallback,
  permission: eligible | remote-manual,
  state: active | stale,
  staleReason?
}
```

去重键包含 repository、worktree、workspace、session、terminal 与规范化 URL。同一 URL 在不同 worktree、不同 session 或不同 terminal generation 中是不同来源；同一来源重复输出保留第一次发现时间。

## URL 与权限边界

- 只把 `http:` / `https:` 且 hostname 精确为 `localhost`、`127.0.0.1`、`[::1]` 的 URL 记为候选。
- 显式端口必须是 `1..65535`；保留合法 path、query 与 fragment；剥离非 URL 的尾随标点和未配对闭合符号。
- 拒绝凭据 URL、非法协议、非法端口、任意公网域名和其他 IP。公网 HTTP(S) 可保持现有“外部浏览器链接”行为，但不获得 Preview 权限。
- 本地候选为 `eligible`，只表示可进入后续安全 surface 的策略评估，不表示本批已经打开页面。
- SSH 终端里的 loopback 记为 `remote-manual`。本批不直连、不探测远端端口、不修改远端配置、不创建 tunnel。
- 本批没有新增 WebView，因此没有网页可获得 Tauri invoke、opener、store、shell、文件或其他高权限桥接。

## 生命周期与降级

- PTY 输出可跨字节 chunk，scanner 使用流式 UTF-8 decoder，只提交越过空白/换行边界的新增文本并保留一个未完成 token；异常连续 token 以 4 KiB 为硬界，不重复解析 rolling history。完整来源键继续提供存储层幂等收敛。
- terminal exit 将该 terminal generation 的 active 候选变为 `stale / terminal-exited`，保留原 URL 与来源身份供后续 UI 解释。
- reconnect 使用新的 `terminalId` generation，不继承旧 generation 的 active 状态。
- workspace hydration 未完成时记录 fallback identity；不伪装成已解析 Git workspace。

## 本批测试与证据

- 两个 worktree 不同端口；相同 URL 的不同 worktree/session 来源；同一来源重复输出。
- localhost、IPv4/IPv6 loopback、query/fragment、尾随标点；公网 URL、凭据、非法协议与非法端口拒绝。
- SSH loopback 只获得 `remote-manual`；terminal exit 后保留 stale/source；hydration 前 local/SSH fallback identity 不混淆。

## 明确 Non-scope

- 不创建 WebView、Preview tab 或 Inspector 页面。
- 不实现地址栏、刷新、前进/后退、缩放、viewport、截图、console/network 摘要。
- 不实现 URL 可达性探测、服务进程关联、SSH tunnel 或端口转发。
- 不进入 Phase 4，不改变 Agent Timeline。

## 下一门

下一独立批次是“安全 WebView surface 与 navigation policy”：必须先定义独立 capability、默认拒绝 Tauri 高权限桥接、允许的 top-level navigation/redirect/window-open/download 策略、外部浏览器逃生口、崩溃隔离和明确的 SSH remote-source UI。该门完成前，`eligible` 不能被解释为已经安全打开，Phase 3 保持进行中。
