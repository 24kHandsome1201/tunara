# Conduit 实现优化 Review：更优雅、更可靠的落地方式

> 日期：2026-06-18  
> 范围：基于现有三份调研/实施文档做第二视角 review。本文不重复基础方案，只聚焦“按当前方案实现时，哪些地方可以更优雅、更少坑、更好维护”。

---

## 总体判断

当前方案的大方向是对的：

- 终端核心复用 terax / portable-pty，不重复造轮子。
- Agent 只接 Claude Code + Codex，砍掉 Cursor，降低异构复杂度。
- Git 读用 `git2`，写用系统 `git` CLI，能继承用户 hooks、签名、凭证。
- MVP 不强行做 xterm 内联 React 组件，先承认渲染模型约束。

但如果直接按实施文档的伪代码往下写，仍会出现两类问题：

1. **局部实现不够优雅**：进程管理、CLI 调用、事件转换、diff 刷新等会散落在多个模块里，后续难维护。
2. **风险处理不够统一**：timeout、cancel、kill、stderr、并发名额释放、dirty work 保护等都是同一类生命周期问题，应该抽象成统一出口，而不是每个 command 自己补一段。

本文建议优先优化这些“结构性实现点”。

---

## 优先级总览

| 优先级 | 优化点 | 当前风险 | 更优雅的实现方向 |
|---|---|---|---|
| P0 | Agent / Git 子进程生命周期统一 | timeout、cancel、stderr、kill、并发释放容易各写各的 | 抽一个 `ProcessRunner` / `ManagedChild`，所有 CLI 调用共用 |
| P0 | 直接写盘后的 baseline / discard 模型 | `git checkout -- file` / `stash` 会误伤用户原有改动 | spawn 前记录 baseline，完成后只计算并回滚“本轮 agent delta” |
| P0 | 渲染模型明确分层 | `InlineAgentBlock` 名字容易暗示能插进 xterm buffer | 明确 `ShellView(xterm)` 与 `AgentTranscriptView(React)` 两条渲染路径 |
| P1 | Agent 事件规范化 | Rust/TS 字段名、CC/CX 事件语义容易漂移 | 定义稳定的 wire protocol，所有字段 camelCase，fixture 锁定 |
| P1 | Git 面板降级策略 | 无 upstream / detached / unborn 会让面板整体失败 | Git 状态拆成 `diffStatus` 与 `remoteStatus`，后者可降级 |
| P1 | Diff 大文件/二进制边界 | 右栏 mini diff 可能被超大 patch 拖死 | 加字节/行数上限、binary 标记、按需展开 |
| P1 | CLI PATH 发现 | macOS GUI app 不继承 shell PATH | 启动时修正 PATH + 设置里允许覆盖绝对路径 |
| P2 | 前端高频 delta 更新 | `reply + delta` 高频复制、重渲染 | chunk buffer + rAF / 50ms 节流提交 React state |
| P2 | Store 持久化策略 | “终态落 store”粒度偏粗 | 存 session metadata + terminal state 派生，避免状态不一致 |

---

## P0：把子进程生命周期抽成统一基础设施

### 问题

当前文档里至少有三类子进程：

- Claude / Codex agent CLI。
- `git commit` / `git push`。
- agent preflight / login status / version check。

它们都需要处理：

- stdout / stderr drain。
- timeout。
- cancel。
- `kill_on_drop`。
- 超时后显式 kill + wait。
- stderr 回显给 UI。
- 进程结束后释放资源。

如果每个 command 手写一份，很快会出现行为不一致：agent 超时能 kill，git 超时不能 kill；agent drain stderr，preflight 不 drain；cancel 释放名额，timeout 忘了释放名额。

### 建议

抽一个后端内部工具模块，例如：

```text
src-tauri/src/modules/process/
├── mod.rs
├── runner.rs        # run_capture / run_streaming
├── managed_child.rs # kill / wait / timeout / cancel guard
└── error.rs         # ProcessError -> UI error
```

建议提供两种 API：

```rust
// 用于 git/preflight：跑完拿 stdout/stderr/status
run_capture(CommandSpec, Timeout) -> Result<CommandOutput, ProcessError>

// 用于 agent：流式读取 stdout 行，同时 drain stderr，支持外部 cancel
run_streaming_lines(CommandSpec, TimeoutPolicy, on_line) -> ManagedProcessHandle
```

`TimeoutPolicy` 不要只有一个总超时，agent 至少需要：

- `wallClockTimeout`：总运行时间上限。
- `idleTimeout`：多久没有任何 stdout/stderr/event 就判定卡死。
- `cancelToken`：用户手动取消。

三者都走同一个终止出口：

```text
timeout / cancel / EOF / exit
        │
        ▼
kill if needed → wait → emit terminal event → cleanup registry → persist final state
```

这样 agent、git、preflight 的行为会天然一致，也更容易写 fake CLI 测试。

---

## P0：直接写盘必须有“本轮改动”模型，而不是只看工作区 diff

### 问题

D1 决策让 agent 直接写盘，这是对的，能显著简化 patch apply 流程。但这也把核心风险转移到了 dirty work 保护：

- 用户启动 agent 前可能已有未提交改动。
- agent 可能改同一个文件。
- 用户在 agent 运行期间也可能手动编辑文件。
- “丢弃改动”如果直接 `git checkout -- file`，会把用户原有改动一起丢掉。

这不是 UI 文案问题，而是数据模型问题。

### 建议

引入 `AgentRunBaseline`，在 `agent_spawn` 前记录：

```rust
struct AgentRunBaseline {
    repo_root: PathBuf,
    head_oid: Option<Oid>,
    index_tree_oid: Option<Oid>,
    worktree_fingerprint: WorktreeFingerprint,
    tracked_files: HashMap<PathBuf, FileFingerprint>,
    untracked_files: HashMap<PathBuf, FileFingerprint>,
    captured_at: DateTime,
}
```

完成后计算：

```text
before(agent start) + after(agent finish) => AgentRunDelta
```

`AgentRunDelta` 应区分：

- `agentOnlyChanges`：启动前干净、agent 本轮新增的改动，可安全展示/丢弃。
- `preExistingChanges`：启动前已有，永远不自动丢弃。
- `conflictedChanges`：启动前已有且 agent 又改了同一路径，不能自动丢弃，只提示人工处理。
- `externalDuringRun`：运行期间检测到非 agent 预期外修改，降级为人工处理。

### 更好的“丢弃改动”语义

不要暴露成“丢弃这个文件”，而是暴露成：

```text
丢弃本次 Agent 改动
```

能自动回滚的只限 `agentOnlyChanges`。遇到 conflict 时按钮禁用或弹出明确提示：

> 这个文件在 Agent 启动前已有改动，无法安全区分本轮改动。请手动处理。

这比 `git stash` / `git checkout` 优雅得多，也不会破坏用户信任。

---

## P0：把渲染模型写成两个明确组件，而不是“内联 AI 块”模糊化

### 问题

设计稿希望“AI 回复内联在终端流里”，但 xterm.js 的 buffer、selection、scrollback、resize 都不是普通 DOM。React 组件不能直接插入 xterm 输出流。

当前文档虽然已经指出这个风险，但组件命名仍有 `InlineAgentBlock.tsx`、`TerminalArea.tsx` 并列，容易让实现者误解成“先用 React 写块，之后塞到 xterm 里”。

### 建议

MVP 直接把渲染边界写死：

```text
SessionViewport
├── ShellSessionView        # kind = shell，内部只有 xterm
└── AgentTranscriptView     # kind = agent，内部是 React transcript blocks
```

也就是说：

- shell 会话是真 xterm。
- agent 会话是 React transcript，不伪装成 xterm。
- 设计稿里的“终端主区视觉”可以复用字体、背景、提示符风格，但不要承诺 xterm buffer 内联。

二期如果要做真正混排，再新增独立架构：

```text
BlockTerminalView
├── ShellCommandBlock       # 已完成命令块，只读 DOM / canvas 快照 / text model
├── AgentBlock              # React
└── ActiveXtermBlock        # 当前交互 xterm
```

这个二期方案涉及命令边界、滚动、复制、搜索、resize、历史重放，不应混进 MVP。

---

## P1：定义稳定的 Agent wire protocol，不让 Rust/TS 字段名漂移

### 问题

Rust 端如果只写：

```rust
#[serde(tag = "kind", rename_all = "camelCase")]
enum AgentEvent { ... }
```

不一定能覆盖 struct variant 字段命名；前端期望 `agentSessionId` / `costUsd` / `loggedIn`，Rust 字段可能实际序列化成 `agent_session_id` / `cost_usd` / `logged_in`。

这种 bug 很隐蔽：UI 能收到事件，但 resume silently broken。

### 建议

把 Rust→TS 的事件协议当作正式 API：

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent { ... }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight { ... }
```

并加一个最小 wire snapshot 测试：

```text
Started { agent_session_id: Some("s1") }
=> { "kind":"started", "agentSessionId":"s1" }
```

这比靠前端“猜字段名”稳定。

---

## P1：Agent parser 不要承诺无法稳定从事件流拿到的 FileChange

### 问题

Claude / Codex 的 JSONL 事件并不一定稳定提供“文件改动列表”。文档里 `AgentEvent::FileChange` 是理想事件，但 Claude parser 只解析了 `system` / `stream_event` / `result`，并没有可靠产出 `FileChange`。

如果 UI 依赖 `fileChange` 刷 diff，CC 路径会漏刷新。

### 建议

把 `FileChange` 改成“优化事件”，不是唯一来源：

```text
diff refresh sources:
1. agent event fileChange（如果有）
2. agent run completed（必须刷新）
3. window focus（必须刷新）
4. session activated（必须刷新）
5. commit / discard finished（必须刷新）
```

更优雅的做法：agent 完成后使用 baseline delta 合成 `FileChange[]`，这样 UI 不依赖具体 CLI 的事件字段。

---

## P1：Git 状态拆成两个独立结果，避免远端状态拖垮 diff 面板

### 问题

`git_ahead_behind` 在以下场景很容易失败：

- 新仓库还没有 commit。
- detached HEAD。
- 没有 upstream。
- upstream 被删除。
- 非 git 目录。

但这些失败不应该影响本地 diff 面板。本地文件改动和远端 ahead/behind 是两个独立能力。

### 建议

后端返回结构拆开：

```ts
type GitPanelState = {
  repo: { ok: boolean; root?: string; reason?: string };
  diff: { files: FileChange[]; summary: string };
  remote: RemoteState;
}

type RemoteState =
  | { state: 'ok'; upstream: string; ahead: number; behind: number }
  | { state: 'noUpstream'; branch: string }
  | { state: 'detached'; oid: string }
  | { state: 'unborn'; branch?: string }
  | { state: 'unknown'; message: string };
```

UI 上：

- diff 成功就展示文件卡。
- remote 失败只在底部显示“未设置 upstream / detached HEAD”，不让整个右栏空白。

---

## P1：`git commit` 默认 `add -A` 不够精细，建议显式显示提交范围

### 问题

当前方案里 `git_commit` 会执行：

```bash
git add -A
git commit -m <msg>
```

这简单，但在 agent 直接写盘模型下风险偏大：它会把用户原有 dirty work、外部编辑器改动、agent 改动全部提交。

### 建议

MVP 至少在 UI 文案上明确：

> 提交当前工作区全部改动

更优雅的实现是与 baseline 结合：

- 默认提交 `agentOnlyChanges`。
- 如果检测到 `preExistingChanges`，单独列出，并要求用户勾选“也包含这些已有改动”。
- 如果有 `conflictedChanges`，禁止一键提交，提示先人工确认。

这会让“AI 改完 → review → commit”闭环更可信。

---

## P1：Diff 面板需要硬边界，避免大文件拖垮 UI

### 问题

`git_diff` 直接返回 patch 字符串，面对以下情况容易卡顿或显示异常：

- 二进制文件。
- 超大 diff。
- minified 文件一行几十万字符。
- rename / mode change / 零字节文件没有 line callback。

### 建议

返回结构化 diff，而不是裸字符串：

```ts
type FileDiff =
  | { kind: 'text'; path: string; hunks: DiffHunk[]; truncated: boolean; totalLines: number }
  | { kind: 'binary'; path: string; size?: number }
  | { kind: 'tooLarge'; path: string; bytes: number; hint: string }
  | { kind: 'metadataOnly'; path: string; change: 'rename'|'mode'|'emptyFile' };
```

建议默认限制：

- mini diff 最多 300 行。
- 单文件 patch 最多 256KB。
- 超限显示“Diff 太大，点击在系统 git 工具中查看”或“展开加载”。

文件列表统计应先用 file callback 登记 delta，再用 line callback 统计增删，避免漏掉零行变更。

---

## P1：macOS GUI PATH 发现要前置成 App 启动能力

### 问题

`cargo tauri dev` 里能找到 `claude` / `codex` / `git`，不代表打包后 Finder 双击 `.app` 能找到。macOS GUI app 通常不继承用户 shell PATH。

### 建议

不要把 PATH 修复散落在 `agent_preflight` 和 `git_commit` 里。启动时统一做：

1. 读取 app 设置里的 CLI 绝对路径覆盖项。
2. 如果没有覆盖项，修正 PATH：
   - 使用 `fix-path-env-rs`；或
   - 从用户 login shell 获取 PATH；或
   - 合并常见路径 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`。
3. 暴露一个统一的 `CommandResolver`：

```rust
resolve_bin("claude") -> ResolvedCommand { path, source: UserOverride | LoginShellPath | SystemPath }
```

设置页显示当前解析结果：

```text
Claude Code: /opt/homebrew/bin/claude   ✓ 已登录
Codex:       未找到                     设置路径…
Git:         /usr/bin/git               ✓
```

验收必须包含“打包后双击 .app 启动”，不能只测 dev 模式。

---

## P2：前端 delta 渲染用 chunk buffer，别每个 token setState

### 问题

文档里把 delta 追加到 `reply` 字符串，比存 `AgentEvent[]` 好，但如果每个 token 都：

```ts
setSession(s => ({ ...s, reply: s.reply + ev.text }))
```

仍会导致：

- 字符串频繁复制。
- React 高频 re-render。
- 长回复时输入/滚动卡顿。

### 建议

事件入口先写入 mutable buffer，再节流提交：

```ts
const pendingText = useRef('');
const raf = useRef<number | null>(null);

function onDelta(text: string) {
  pendingText.current += text;
  if (raf.current == null) {
    raf.current = requestAnimationFrame(() => {
      const chunk = pendingText.current;
      pendingText.current = '';
      raf.current = null;
      appendReplyChunk(sessionId, chunk);
    });
  }
}
```

如果事件特别密集，可改成 50–100ms batch。UI 仍然像打字机，但 CPU 稳定很多。

---

## P2：Store 里存“事实”，UI 状态尽量派生

### 问题

如果 store 里直接存 `status: fresh | done | failed`，会遇到：

- `fresh → done` 定时降级是否落盘？
- 重启后“刚完成”是否还应该是 fresh？
- 通知未读数如何恢复？

### 建议

store 存更稳定的事实字段：

```ts
type PersistedSession = {
  id: string;
  kind: 'shell' | 'agent';
  dir: string;
  title: string;
  agent?: 'CC' | 'CX';
  agentSessionId?: string;
  runState: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  startedAt: number;
  completedAt?: number;
  error?: string;
  resultSummary?: string;
  unread?: boolean;
}
```

UI 的 `fresh` 可以派生：

```ts
fresh = runState === 'completed' && Date.now() - completedAt < FRESH_WINDOW && unread
```

这样重启、通知、状态降级会更一致。

---

## 可以顺手修正文档中的小不一致

以下不是架构风险，但建议下一版文档顺手改掉，避免误导实现者：

1. `commit.rs # git_commit(git2)` 应改为 `git_commit/git_push via system git CLI`。
2. 如果 MVP 不实现 `agent_write`，就不要在 `invoke_handler` 和前端契约里注册；多轮统一用 resume 重新 spawn。
3. D6 决策表里“超过排队”与实施文档“超限拒绝 + 提示”需要统一。建议 MVP 写“拒绝 + 提示”，排队放二期。
4. `InlineAgentBlock` 如果保留命名，建议备注“仅 AgentTranscriptView 内联，不是 xterm buffer 内联”。
5. 验收清单里的“敏感写入有通知”建议改成“受保护路径优先阻断/失败提示；真实发生的高风险改动才持久通知”。

---

## 推荐的下一步实现顺序

如果要把这些优化并入实施计划，建议按这个顺序：

1. **先定基础设施**：`ProcessRunner` / `CommandResolver` / `AgentRunBaseline` 三个底座。
2. **再定协议**：`AgentEvent` wire protocol + serde rename + TS 类型 + snapshot 测试。
3. **再写 agent harness**：CC/CX parser 只负责归一化事件，不负责 UI 状态。
4. **再写 Git 面板**：diff 与 remote status 分离，支持降级。
5. **最后做 UI polish**：ShellView / AgentTranscriptView 分流，delta batch，diff limits。

这样实现会比“先拼 UI，再到处补后端边界”更稳。

---

## 最重要的 5 个落地建议

1. **所有 CLI 子进程必须走统一 runner**：这是最能减少隐性 bug 的优化。
2. **D1 直接写盘必须绑定 baseline/delta/discard 模型**：否则迟早误伤用户 dirty work。
3. **MVP 明确 agent 是 React transcript，不是 xterm 内联**：不要在最早阶段把渲染复杂度做爆。
4. **Git 面板必须能降级**：本地 diff 可用，不应被 upstream/detached 等远端状态拖垮。
5. **打包后 CLI 发现是验收项**：dev 模式能跑不代表真实用户能跑。
