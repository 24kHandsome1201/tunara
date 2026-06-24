# AGENTS.md — Tunara 仓库约束（面向 AI coding agent）

> 本文件是 agent（Claude Code / Codex / Cursor 等）进入本仓库前必须读取并遵守的硬约束。
> 它编码的是「读代码看不出、但改错了会出事」的不变量。**绿色 CI 不代表安全**——见 §2。
> Claude Code 用户可 `ln -s AGENTS.md CLAUDE.md`。

Tunara = **带智能侧栏的真实终端**（Tauri v2 + React 19 + xterm.js 6 + Rust）。
它**不是** agent 编排平台 / 聊天工具 / MCP orchestrator / IDE / Git GUI。

---

## 0. 动手前的决策门

收到任务，先按顺序自问：

1. 这个改动会不会突破 §1 的产品边界？→ 会则停下，先和人确认，别擅自扩张产品。
2. 我要碰的东西是不是 §3 的「单一真相源」或 §4 的「已知债务」？→ 是则按那里的规则同步所有副本 + 测试锁。
3. 我要改的文件在不在编译图里（§2）？我能不能在本地跑通 §8 的完整 gate？
4. 这是 UI 改动吗？→ 是则源码测试绿 **不等于** 完成，需真实 Tauri 窗口冒烟（§9 DoD）。

---

## 1. 产品边界（最高优先级，违反即回退）

Tunara 的定位是「轻量、好看、带侧栏的现代终端」。真实 xterm/PTY 是主角；侧栏按工作目录组织会话、显示运行状态与 agent 识别；右栏是**只读** diff/文件审查面板。

**永远不要新增以下方向（已被明确砍掉，代码里留有「砍除证据」）：**

- ❌ 独立「新建 Agent」弹层 / agent catalog / 从命令面板或设置页「启动 Agent」按钮。
  用户在真实终端里自己运行 `claude` / `codex` 等 CLI，Tunara **只做识别、品牌标记、状态、review 辅助**。
- ❌ 「启动所有 Agent」/ `launchAllAgents` 这类批量启动入口。
- ❌ DiffPanel 里的 commit / push / stage 按钮。审查面板**保持只读**，写操作交给终端里的 `git` 或 agent 自己。
- ❌ 内置 AI 聊天 / AI 问答 / BYOK 模型集成。
- ❌ MCP 协议 / agent 编排 / 多 agent 通信 / 云能力。
- ❌ 内置文件编辑器（编辑交给外部编辑器，`open_in_editor` 一键跳转即可）。
- ❌ 递归 / 无限分屏（一次 split、最多 2 pane 是刻意的）。
- ❌ 为各 agent 写 stdout 结构化 parser（输出格式不稳定，维护成本爆炸）。
- ❌ 插件系统 / SSH 远程 / 自研渲染引擎。

如果某个「优化」让 Tunara 更像 Warp 或 cmux，那它大概率越界了。

---

## 2. 编译图陷阱：不要相信绿灯（必读）

**事实：仓库里存在「在磁盘上、但不在编译图里」的 `.rs` 文件。** 它们没有被 `src-tauri/src/modules/mod.rs` 声明为 `mod`，因此 `cargo build` / `clippy` / `rustfmt` **完全看不到它们**：

- `src-tauri/src/modules/secrets.rs`（keyring/文件后备的密钥存储，~190 行）—— **当前是死代码**，文件头声称「frontend talks to `secrets_get`...」但没有任何调用方，`lib.rs` 的 `invoke_handler` 里也没注册。
- `src-tauri/src/modules/shell/`（`mod.rs` + `background.rs` + `ringbuffer.rs` + `session.rs`，后台进程/环形缓冲，~20KB）—— **当前是死代码**，是被砍掉的 agent 平台底座残留。

**规则：**

- 不要假设「`pnpm test` / `cargo clippy` 绿」覆盖了所有 `.rs` 文件。任何未 `mod` 进来的文件，gate 都是瞎的。
- **不要新增孤儿 `.rs` 文件。** 每个新文件都必须被某个 `mod` 链接到 crate root，否则它能编译不过/有 bug 而无人知晓。
- 若任务要复活 `secrets` / `shell`：必须先 `mod` 进 `modules/mod.rs`，并确保它能过 `clippy -D warnings`（大概率不能，里面有未处理的 `.unwrap()`）。
- 若任务是清理：直接删除这两块，而不是留在树里。**二选一，不要保留中间态。**

---

## 3. 单一真相源（改一处=改全部+锁测试）

### 3.1 Agent 注册表

唯一真相源：**`src/modules/agent/registry-data.json`**（字段：`code / name / commands / shellTitleFragments / cliBin`）。

它被两端共享：

- 前端：`src/modules/agent/registry.ts` 派生出 `AGENT_NAMES` / `AGENT_COMMANDS` / `AGENT_CODES` / `AGENT_SHELL_TITLE_FRAGMENTS`。`src/ui/types.ts` 再 re-export `AGENT_NAMES`（**不要**另写一份）。
- Rust：`src-tauri/src/modules/resolver/mod.rs` 通过 `include_str!("../../../../src/modules/agent/registry-data.json")` 读取同一份。

**规则：**

- 增删 agent **只改这个 JSON**。
- 改完同步更新 `resolver/mod.rs` 测试里的 `assert_eq!(entries.len(), N)` 和关键映射断言（`CP→gh`、`CR→cursor` 等）。
- **不要**新增第 4 个 agent 真相源。

### 3.2 终端主题名

`TerminalThemeName` 由 `src/styles/terminalTheme.ts` 的 `TERMINAL_THEME_NAMES` 数组派生；localStorage 校验复用同一数组。新增主题改这一处，不要手写第二份枚举。

### 3.3 版本号（5 处必须一致）

打 release 前，以下 5 处版本必须完全一致：

- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`（同时跑 `cargo update -p tunara` 让 `Cargo.lock` 跟上）
- `src-tauri/tauri.conf.json` → `"version"`
- `homebrew/tunara.rb` → `version`
- `CHANGELOG.md` → 必须有对应版本条目（不能只停在 `## Unreleased`）

**规则：** 版本一起 bump；**release tag 上严禁 `sha256 :no_check`**——必须用真实发布 DMG 的 sha256 回填。
（当前仓库这 5 处是漂的：app=1.2.0 / homebrew=1.1.0 / changelog 无版本条目 / `:no_check` 未回填。修复时一并对齐。）

---

## 4. 已知技术债（这些是刻意标注的，别「发现后默默绕过」）

- **`preflight.rs::agent_bin` 是 §3.1 的重复真相源且已漂移。** 它硬编码了 ~18 个 agent（含 `aider/cline/roo/kilo-code/void/codename-goose`），而 `registry-data.json` 只有 11 个。碰 agent 相关代码时，把它并回 JSON（给 JSON 加 `cliBin` 消费 + 像 resolver 那样的测试锁），并删掉注册表里不存在的死分支。
- **`agentResume` 链路是断的。** `src/state/persist.ts` 完整定义并 sanitize 了 `PersistedAgentResumeIntent`，但唯一生产者 `src/app/useInit.ts::buildSnapshot()` 写死了 `agentResume: {}`。**不要删这个 schema**；若实现「重启续上 agent 会话」，在 `buildSnapshot()` 里补生产者（在 `detectAgentCommand` 命中时记 `{agent, cwd, command, resumeId, lastSeenAt}`）。
- **Codex 状态检测靠刮屏，脆。** `agent-lifecycle.ts::hasCodexBusyIndicator` 硬编码英文串（`Working` / `esc to interrupt` 等），`codexDataBurstCount >= 3` 是 magic number。改动前理解：claude/droid 走可靠的 hook 通道（OSC 777 + 注入 `--settings`），codex 只有 start/exit、其余全靠屏幕文字。要动就把 pattern 外置成可配置/带版本兜底，别让它更脆。

---

## 5. 核心运行时不变量（改错会破坏终端语义）

### 5.1 TerminalView 的空依赖 effect 是刻意的

`src/ui/TerminalView.tsx` 主 `useEffect(..., [])` 上的 `eslint-disable react-hooks/exhaustive-deps` **不要去「修」**。把 `dir` 加进依赖会导致**每次 `cd` 都销毁并重建整个 PTY/xterm**。cwd 是通过 OSC 7 在 spawn 后动态跟踪的，不靠 effect 重跑。

### 5.2 切 tab 用 display 隐藏，绝不 dispose

每个会话有常驻、独立的 PTY/xterm 实例；切换 tab 时用 `display` 隐藏，**不销毁**。后台终端的输出和运行中的进程必须存活。不要在 tab 切换时卸载 terminal 组件。

### 5.3 PTY 背压：整段丢弃，不切片

`src-tauri/src/modules/pty/session.rs` 的 `MAX_PENDING` 溢出时**丢弃整个 pending buffer 并写入 `ESC c`（硬复位）**。**不要**改成「丢弃前缀/部分」——那会把 CSI 转义序列切成两半，污染 xterm 屏幕状态。

### 5.4 Shell 集成契约（OSC）

shell 通过 OSC 7（cwd）+ OSC 133 A/B/C/D（prompt-start / prompt-end / pre-exec / command-done）+ OSC 777（`tunara-agent;event;session;agent;code` agent 生命周期）与前端通信。rc 脚本在 `src-tauri/src/modules/pty/scripts/*`，通过 `include_str!` 内联（**改脚本=改这些真实文件**，不是改字符串字面量）。原子写（tmp+rename）不要改成直接写。

`agent/hooks.rs` 的测试锁定了哪些 agent 被哪种 wrapper 包裹：`claude`/`droid` → `_tunara_agent_run`（带 hook），`codex` → `_tunara_agent_plain_run`（无 hook）。改 wrapper 必须同步更新该测试。

### 5.5 会话状态：存事实，派生展示

`Session` 只存事实字段（`agent` / `agentActivity` / `runState` / `lastCommand` / `lastExitCode` ...）。展示态由 `src/modules/terminal/lib/session-lifecycle.ts` 里的纯函数 `*Update`（`agentDetectedUpdate` / `agentBusyUpdate` / `commandFinishedUpdate` ...）派生。

**规则：** 新增生命周期行为 = 加一个**纯** `*Update` 函数（可单测），返回 `{patch, refreshGit?}`；**不要**把状态机逻辑内联进 store 或组件。store（`src/state/sessions.ts`）只负责调度这些纯函数 + 落 toast。

### 5.6 Git 读写分离

读：`git_status` / `git_diff` / `git_ahead_behind` 用 git2 结构化读取，**不 spawn 子进程**。降级用枚举表达（`FileDiff::{Text,Binary,TooLarge,MetadataOnly}`、`RemoteState::{Ok,NoUpstream,Detached,Unborn,Unknown}`），不要用裸字符串或 panic。
写：已从 IPC 移除。`git/commit.rs` 是 `#[cfg(test)]`-only 的回归 fixture，**保持 test-only，不要暴露为 Tauri command**。

### 5.7 持久化

用 Tauri `store` 插件，**严禁 `localStorage` / `sessionStorage`**（在 Tauri webview 不可靠）。快照 schema 是 `WorkspaceSnapshotV1`，加字段必须同步更新 `sanitizeSnapshot`（带版本与类型校验、按 `sessionIds` 过滤孤儿）。

---

## 6. 安全约束（不要在没理由的情况下放宽）

- **CSP 已锁死**（`tauri.conf.json`）：`script-src 'self'`、无 `unsafe-eval`。不要为了省事加 `unsafe-eval` 或放开 `connect-src`。
- **Capabilities 最小权限**（`capabilities/default.json`）：新增 IPC 能力要显式、按需，不要整组放开。
- **不要把密钥/token 写进 world-readable 的 `/tmp`。** 现有 hooks socket（`/tmp/tunara-hooks-{pid}.sock`）和注入文件（`/tmp/tunara-agent-{sid}.json`）已是已知的弱点；若加固，往 `$XDG_RUNTIME_DIR` 或 0700 目录移、payload 带 per-session nonce，别新增可预测的 `/tmp` 文件。
- **OSC 52 剪贴板是安全 sink。** 终端程序写系统剪贴板必须默认关闭，只能通过 `~/.config/tunara/config.toml` 的 `terminal_clipboard_write = true` 或设置页显式开启；Primary DA（`CSI c` / `CSI 0 c`）只有在该配置开启时才能声明扩展能力 `52`；不要实现剪贴板读取响应（`OSC 52 ; Pc ; ?`），不要静默默认允许，payload 必须保持 UTF-8 文本和大小上限。
- agent 圆形图标等颜色走 `--c-agent-*` token；阴影走 `--shadow-*`。**不要硬编码颜色**。

---

## 7. 代码风格与栈约束

- **栈是刻意精简的**：前端 React 19 + Zustand 5 + xterm 及其 addon；Rust `portable-pty` / `git2`(vendored) / `which` / `tokio` / `ignore`/`grep-*`。**不要随手加依赖**，尤其不要引入重型框架/UI 库/拖拽库（拖拽用原生 HTML5 DnD）。
- TypeScript strict + `tsc --noEmit` 必须过；导入用 `@/` alias。
- **React key 不许用数组索引**（有回归测试盯着）。用显式 `id` 或内容派生 key。
- 重复的 SVG/样式抽到 `src/ui/shared.tsx` / token，不要各组件复制。
- Rust：`rustfmt` + `clippy -D warnings` 必须过；避免在非测试代码引入 `.unwrap()`/`panic`（锁 `.lock().unwrap()` 除外，那是 poisoned-abort 惯例）。

---

## 8. 构建与验证命令

```bash
pnpm install
pnpm build        # tsc && vite build —— TS 必须无类型错误
pnpm typecheck    # tsc --noEmit
pnpm test         # = pnpm test:node && cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:node    # node --experimental-strip-types --test tests/*.test.mjs

# Rust gate（CI 会跑，本地也必须过）
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 跑起来（注意 §2：上面的 gate 看不到孤儿模块）
pnpm tauri dev    # 或 pnpm tauri:dev（用 src-tauri/tauri.conf.dev.json）
```

**文件尺寸硬约束：** 单个源码文件 **不得超过 500 行**（有 line-count 回归测试盯 `TerminalView.tsx` / `Sidebar.tsx` 等热点）。超了就拆纯函数/hook，不要靠加注释蒙混。当前 `TerminalView.tsx` 已逼近上限（~482 行），里面那个巨型 effect 是优先可拆对象（`usePtyBridge` / `useAgentLifecycle`）。

---

## 9. Definition of Done（声称完成前自检）

- [ ] §0 决策门走过：没有突破 §1 产品边界。
- [ ] 改了 §3 单一真相源 / §4 已知债务的，所有副本与测试锁已同步。
- [ ] 没有新增孤儿 `.rs` 文件；碰过的旧孤儿要么接回编译图、要么删除（§2）。
- [ ] `pnpm build`、`pnpm test`、`cargo fmt --check`、`cargo clippy -D warnings` 全绿。
- [ ] 没有文件超过 500 行。
- [ ] **UI 改动**：在真实 Tauri 窗口里冒烟过——启动 app、终端输入、切分屏、开设置、右键菜单键盘操作、窄窗口 overlay。源码测试绿 ≠ 完成。
- [ ] 涉及发布的：§3.3 五处版本一致，无 `:no_check`。
- [ ] 第三方复用（Apache-2.0 的 terax PTY/shell-integration 等）已在 `THIRD_PARTY_NOTICES.md` 留痕。

---

## 10. 写给 agent 的口径

- 不确定某个改动是否越界（§1）或是否在编译图里（§2）时，**停下来问人**，不要擅自扩张产品或默默绕过陷阱。
- 报告进度时只说**当前分支的真实状态 + 本机命令的真实输出**。不要把「源码测试通过」说成「已验证可发布」。
- 看到 §4 的已知债务，是来**消除**它的，不是来「适配」它的。
