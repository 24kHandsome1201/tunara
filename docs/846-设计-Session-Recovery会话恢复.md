846

# Session Recovery 会话恢复方案

> 背景：Otty 的体验启发是“关闭后重开，每个 pane 的精确位置和滚动位置都恢复”。Conduit 当前已经有 session metadata 和部分 UI layout 持久化，但还没有把工作台现场恢复到足够接近关闭前的状态。

## 目标

把 Conduit 的恢复能力从“会话列表恢复”升级到“工作台现场恢复”：

- 恢复 active session。
- 恢复侧栏展开/折叠状态。
- 恢复右侧 DiffPanel 显隐状态。
- 恢复目录分组折叠状态。
- 恢复 split pane 布局、pane session 和比例。
- 恢复已打开终端的可见内容和滚动位置。
- Claude Code / Codex 会话在可识别 resume id 时进入可续接状态。

用户感知目标：重开 Conduit 后，窗口看起来应尽量像刚才关闭前那一刻，而不是只剩一个重新启动的空 shell。

## 非目标

- 不承诺 App 退出后 PTY 进程仍然存活。
- 不引入后台 daemon 保活 shell。
- 不做无限 scrollback 持久化。
- 不自动重启所有后台 session。
- 不把 Conduit 扩成 agent 管理平台、agent launcher 或对话历史系统。
- 不把 React 组件塞进 xterm buffer；终端恢复仍以 xterm buffer 快照为边界。

当前 Rust 端在窗口 destroyed 时会 `close_all()`，所以关闭 App 后真实 PTY 会被杀掉。v1 恢复的是 UI 现场、终端 buffer 快照、滚动位置和 resume intent，而不是原 Unix 进程。

## 当前状态

已有能力：

- `src/state/persist.ts` 已保存 `sessions`、`activeSessionId`、`uiLayout`。
- `uiLayout` 目前只有 `sidebarVisible` 和 `panelVisible`。
- `src/state/ui.ts` 已有 `split`、`collapsedDirs`、`sidebarWidth`、`panelWidth` 等状态。
- `src/app/useInit.ts` 已在 close requested、session 变更、30 秒定时保存 session。
- `TerminalView` 已经做到切 tab 不销毁 xterm/PTY；后台 session 通过 `display: none` 保活。
- Rust PTY 已用 `logicalSessionId` 避免同一个逻辑 session 重复启动多个 PTY。

缺口：

- `collapsedDirs` 不落盘。
- `split` 不落盘。
- `sidebarWidth` / `panelWidth` 在 localStorage，和 Tauri store 的 layout snapshot 分散。
- xterm buffer / scroll viewport 不落盘。
- agent resume intent 没有结构化保存。
- 启动恢复流程没有区分“只恢复卡片”和“立即启动 PTY”。

## 推荐方案

新增一个 versioned workspace snapshot，作为会话恢复的唯一入口。

### 1. 持久化模型

在 `src/state/persist.ts` 中引入：

```ts
type WorkspaceSnapshotV1 = {
  version: 1;
  savedAt: number;
  activeSessionId: string | null;
  sessions: PersistedSessionV2[];
  ui: PersistedUILayoutV2;
  terminals: Record<string, PersistedTerminalSnapshot>;
  agentResume: Record<string, PersistedAgentResumeIntent>;
};

type PersistedUILayoutV2 = {
  sidebarVisible: boolean;
  panelVisible: boolean;
  collapsedDirs: Record<string, true>;
  split: {
    mode: "single" | "horizontal" | "vertical";
    paneA: string | null;
    paneB: string | null;
    ratio: number;
  };
  inspectorTab: "changes" | "files";
};

type PersistedTerminalSnapshot = {
  serialized: string;
  viewportY: number;
  baseY: number;
  cols: number;
  rows: number;
  capturedAt: number;
  truncated: boolean;
};

type PersistedAgentResumeIntent = {
  agent: "CC" | "CX" | "AM" | string;
  command: string;
  cwd: string;
  resumeId?: string;
  lastSeenAt: number;
  confidence: "exact" | "continue" | "unknown";
};
```

保留旧的 `sessions` / `activeSessionId` / `uiLayout` 读取兼容，第一次读取旧格式后写回 `WorkspaceSnapshotV1`。

### 2. xterm 快照

新增依赖：

```json
"@xterm/addon-serialize": "^0.13.0"
```

在 `TerminalView` 里加载 `SerializeAddon`：

- terminal 初始化后 `term.loadAddon(serializeAddon)`。
- 每个 terminal 暴露 `captureSnapshot(sessionId)`。
- 快照内容包括 `serializeAddon.serialize()`、`term.buffer.active.viewportY`、`term.buffer.active.baseY`、`term.cols`、`term.rows`。
- 保存前对 `serialized` 做大小上限，例如 512KB；超过则只保留尾部并标记 `truncated: true`。

恢复时：

1. 创建 xterm。
2. 先写入 `snapshot.serialized`。
3. `fit.fit()` 后恢复滚动位置。
4. 再启动新的 PTY。

这样用户能看到关闭前终端内容和滚动位置，但新的 shell 仍是一个新进程。

### 3. 恢复启动顺序

启动流程改成严格顺序：

```text
loadWorkspaceSnapshot()
  -> sanitizeSnapshot()
  -> set UI store: sidebar/panel/collapsedDirs/split/inspectorTab
  -> set sessions store: sessions/activeSessionId
  -> mark launchedSessionIds only for active + split panes
  -> TerminalView mount
  -> replay xterm snapshot
  -> open new PTY with logicalSessionId
  -> optional agent resume prompt/injection
```

关键点：

- 不要启动所有历史 session 的 PTY。
- active session 必须启动。
- split pane 中的 paneA/paneB 必须启动。
- 其他 session 只恢复侧栏卡片，用户切过去时再启动。
- 如果 split 里引用的 session 已不存在，降级为 single mode。

### 4. Agent resume intent

Conduit 不应该偷偷把 agent 当作后台任务重启。v1 只做可恢复意图：

| Agent | 可恢复方式 | 行为 |
| --- | --- | --- |
| Claude Code | `claude --resume <sessionId>` 或 `claude --continue` | 有 exact id 时可生成恢复命令；无 id 时提示继续最近会话 |
| Codex | `codex exec resume <sessionId>` 或 `codex exec resume --last` | 有 exact id 时生成恢复命令；无 id 时只给继续入口 |
| Amp / 其他 CLI | unknown | 只恢复 terminal buffer，不自动重启 |

捕获来源：

- 用户输入命令时识别 `claude` / `codex`。
- 终端标题或输出中若能解析 session id，则保存 `resumeId`。
- 无法可靠解析时，保存 `confidence: "unknown"`。

恢复 UI：

- 如果 active session 有 `agentResume`，在 terminal 顶部 status bar 显示“可恢复 Claude Code 会话”。
- 用户确认后把 resume 命令写入 PTY，不自动执行危险命令。
- 对 `confidence: "exact"` 可考虑一键执行；对 `continue` / `unknown` 只填入命令等待用户回车。

## 保存策略

### 触发时机

- session 增删、重命名、排序、cwd 变更。
- active session 变化。
- sidebar/panel/collapsedDirs/split/inspectorTab 变化。
- terminal 输出停止后 debounce 1 秒保存快照。
- App close requested 时强制保存。
- 30 秒定时兜底。

### 写入方式

- 统一 `saveWorkspaceSnapshot(snapshot)`。
- session/ui 高频变化 debounce 300-500ms。
- terminal buffer 快照 debounce 1000ms。
- close requested 强制 flush 所有 pending save。

### 数据清理

- 只保留最近 20 个 terminal snapshots。
- 单个 terminal serialized 上限 512KB。
- 总 snapshot 上限建议 5MB。
- 超限时按 `updatedAt` 删除最旧 session 的 terminal snapshot，但保留 session metadata。

## 实施步骤

### Phase 1：Workspace snapshot 统一入口

涉及文件：

- `src/state/persist.ts`
- `src/app/useInit.ts`
- `src/state/ui.ts`
- `tests/project-review-regressions.test.mjs`

内容：

1. 新增 `WorkspaceSnapshotV1` 类型和 sanitizer。
2. 新增 `saveWorkspaceSnapshot` / `loadWorkspaceSnapshot`。
3. 兼容旧 `loadSessions` / `loadUILayout`。
4. `useInit` 改成一次性加载 workspace snapshot。
5. 保存 `collapsedDirs`、`split`、`inspectorTab`。
6. 修复 split 引用已删除 session 的降级逻辑。

可独立合并。即使没有 xterm snapshot，也能恢复完整 UI layout。

### Phase 2：xterm buffer + scroll snapshot

涉及文件：

- `package.json`
- `pnpm-lock.yaml`
- `src/ui/TerminalView.tsx`
- `src/ui/MainArea.tsx`
- `src/state/persist.ts`

内容：

1. 引入 `@xterm/addon-serialize`。
2. `TerminalView` 加载 SerializeAddon。
3. 建立 terminal snapshot registry。
4. terminal 输出 debounce 后更新 snapshot。
5. 恢复时先 replay serialized buffer，再 open PTY。
6. 恢复 viewportY。

可独立合并。失败时应降级为只恢复 session metadata，不影响正常启动。

### Phase 3：Agent resume intent

涉及文件：

- `src/ui/TerminalView.tsx`
- `src/modules/terminal/lib/agent-lifecycle.ts`
- `src/state/persist.ts`
- `src/ui/AgentStatusBar.tsx`

内容：

1. 保存 `agentResume`。
2. 识别 Claude Code / Codex resume id 或 continue 能力。
3. 启动恢复后在 AgentStatusBar 显示恢复入口。
4. 用户确认后写入 resume 命令。

可独立合并。没有 resume id 时不影响普通 terminal 恢复。

## 风险与处理

### 1. 用户误以为进程仍在运行

处理：恢复后 status bar 明确区分：

- `Restored snapshot`：这是关闭前画面快照。
- `New shell`：底层 shell 是新进程。
- `Resume available`：agent 可续接。

### 2. 快照过大拖慢启动

处理：

- 单 terminal 512KB。
- 总 snapshot 5MB。
- 只 eager restore active/split panes。
- 后台 session lazy restore。

### 3. xterm replay 后新 shell 输出接在旧内容后面

处理：

- replay 后写一行 dim separator：

```text
[conduit restored snapshot, new shell started below]
```

这行可以用低对比度样式，不抢视觉，但避免语义混淆。

### 4. split/session 引用不一致

处理：

- `sanitizeSnapshot()` 校验所有 session id。
- activeSessionId 不存在时取第一个 session。
- split paneA/paneB 任一不存在时降级 single。
- collapsedDirs 可保留，即使当前没有该目录。

### 5. Agent resume 命令误执行

处理：

- v1 默认不自动回车。
- 只把命令预填进终端，等待用户确认。
- exact resume id 可在设置里允许“一键执行”，但默认关闭。

## 验收标准

### 自动测试

- 旧格式 persist 能迁移到 `WorkspaceSnapshotV1`。
- `sanitizeSnapshot()` 能处理缺失 active、失效 split、重复 session。
- `collapsedDirs` / `split` / `inspectorTab` 能 round-trip。
- terminal snapshot 超限时被截断且不影响 session metadata。
- agent resume intent 无 resume id 时不会自动执行。

### 手动测试

1. 打开两个 terminal，切换 active session，关闭重开，active session 不变。
2. 折叠 sidebar，再重开，sidebar 仍折叠。
3. 折叠某个目录分组，再重开，目录分组仍折叠。
4. 打开右侧 DiffPanel，再重开，右栏仍打开。
5. 创建 split pane，调整比例，再重开，split 和比例恢复。
6. 在终端输出长内容，滚动到中间，关闭重开，内容和滚动位置恢复到相同区域。
7. 输入 `claude` 或 `codex`，退出 App 后重开，session 仍显示 agent resume 入口，但不自动执行新任务。
8. 删除某个持久化 session 后重开，不出现空 pane 或重复 PTY。

### 验证命令

```bash
pnpm build
pnpm test
pnpm tauri dev
```

浏览器预览只能检查 layout，不能作为 PTY/session recovery 的最终验证。最终验收必须在 Tauri 真窗口里关闭重开。

## 结论

这个方案的重点不是把 Conduit 做成 tmux 或后台 agent 平台，而是补上现代终端最强的“现场感”：关闭重开后，用户回到同一个工作台、同一个 session、同一个 scroll 位置。实现上应先统一 workspace snapshot，再接 xterm serialize，最后补 agent resume intent。这样每一步都能独立合并，也不会破坏当前“带智能侧栏的真实终端”边界。
