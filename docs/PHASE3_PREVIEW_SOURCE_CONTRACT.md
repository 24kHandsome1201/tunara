# Phase 3 Workspace-bound Preview：来源绑定、安全 WebView 与导航策略

## 来源检测切片

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

## 安全 WebView surface 切片

本切片把 `eligible` 变成可由用户显式打开的独立原生 Preview window，但不建设通用浏览器。入口位于当前 session 的 Inspector Preview tab；每张来源卡完整显示 repository、worktree、session、terminal generation 与 URL，并提供打开/聚焦、刷新、关闭和外部浏览器逃生口。runtime state 的键继续包含完整来源身份，因此相同 URL、不同 worktree/session/terminal 不共享窗口。

### 双层准入

前端只启用 `transport=local + permission=eligible + state=active + workspaceResolution=resolved` 的内置打开按钮；Rust command boundary 再独立验证完全相同的条件、`workspaceId=repositoryId::worktreeId`、terminal generation 属于 session、URL 无凭据且为精确 loopback。SSH `remote-manual`、stale、fallback 和任意公网 URL 即使绕过 UI 构造 payload 也会被 Rust 拒绝。

### 独立 WebView 与 capability

- Preview 使用 `preview-<完整来源 SHA-256 前缀>` 的独立 `WebviewWindow`，不复用 `main` 窗口。
- `preview-untrusted-loopback` capability 只匹配明确 loopback remote URL，并设置 `local=false / permissions=[]`；主窗口的 opener、store、dialog、updater、window-state 等 capability 只匹配 `main`。
- 远程页面仍必须用真实 fixture 主动探测 `window.__TAURI_INTERNALS__ / window.__TAURI__` 并尝试代表性 app command 与 plugin command；空 permissions 只是结构证明，不能替代运行时拒绝证据。
- 用户用原生关闭按钮销毁 Preview 时，`WindowEvent::Destroyed` 清除 Rust 注册状态；之后同一来源可重新创建。页面加载失败或 Preview 关闭不关闭 PTY，不隐藏或销毁主窗口。

### 集中导航策略

Rust `allowed_origin / navigation_allowed` 是唯一 top-level policy：初始 URL 必须为无凭据的 HTTP(S) 精确 loopback；后续 top-level navigation 与 redirect 必须保持与初始来源完全相同的 scheme、host 和 effective port。路径、query、fragment 可变化；跨端口 loopback、公网 redirect、外部协议、凭据 URL全部 fail closed。

`window.open` / popup 固定返回 `Deny`；download handler 固定返回 `false`；不向页面提供地址栏、前进后退、缩放、viewport、DevTools、书签、账号或标签页。外部浏览器动作只存在于可信的 main Inspector 控制面，不由不可信页面静默触发。

## 本批真实验收门

- optimized macOS Tauri app 加载受控 eligible fixture；主动 IPC/app/plugin 探针只能得到桥接缺失或 capability 拒绝。
- 同 origin navigation 与刷新成立；公网 redirect、跨端口 loopback、外部协议、popup、download 均不离开/不落盘/不生成新页面。
- 两个 linked worktree、不同 session/terminal/端口的来源标签与窗口保持独立。
- 用户原生关闭后可再次打开；页面失败、关闭与刷新不影响 PTY 输入回显及 main window。

## 下一门

下一独立批次才是最小导航/页面失败与服务生命周期闭环；前进后退、地址栏、缩放、viewport、截图、console/network 摘要、服务重启关联和 SSH tunnel 仍留在后续决策。安全 WebView surface 完成也不得解释为 Phase 3 已完成，更不得进入 Phase 4。
