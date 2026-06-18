# Conduit 终端 — 前端设计 & 终端核心可复用性调研

> 调研日期：2026-06-18
> 范围：① 把交付的设计稿（Conduit）研究透；② 调研 Tauri + xterm.js + portable-pty 的现成项目，判断「终端部分能否直接用」。
> 结论先行：**外壳（UI）需要按设计稿用前端框架重写；终端核心不必从零造，应以 Apache-2.0 的 `terax-ai-tauri-terminal` 为蓝本，它已实现本项目最难的几块（多 PTY 并发、背压、shell 集成、文件树）。**

---

## 第一部分：设计稿研究（Conduit）

### 1.1 交付物性质

设计交付包 `Tauri 终端侧边栏设计.zip` 内含三个文件：

| 文件 | 性质 | 用途 |
|------|------|------|
| `README.md` | 设计交接文档 | **唯一规范来源**：design tokens、布局、交互、状态模型全部写死 |
| `Conduit.dc.html` (56K, 508 行) | 可交互高保真原型 | 主参考，三栏 + 全部弹层都能点 |
| `Terminal Concepts.dc.html` (100K) | 5 种风格探索看板 | 结论：**Paper（浅色）即最终方向**，其余仅备选，不实现 |

> ⚠️ **HTML 不是生产代码**。它用了一套内部 DSL（`<x-dc>` / `class Component extends DCLogic` / `{{ }}` 插值 / `<sc-if>` 条件块 / `./support.js`），只描述外观与交互。README 第 9 行明确要求：**用目标框架（React/Svelte/Vanilla TS）按像素复刻视觉壳层，终端区换成真实 xterm.js**。所以 HTML 的价值是「精确的视觉/交互真值」，不是可拷贝的代码。

### 1.2 产品定位（关键：比"带侧边栏的终端"更进一步）

Conduit 是一个 **AI 原生终端**，不是普通终端：

- **侧边栏不是文件树**，而是**按工作目录分组的会话列表**，每个会话挂一个 AI agent（CC=Claude Code / CX=Codex / CU=Cursor）。
- **主区是真实终端流**，AI 的回复**内联**渲染在终端里（带「应用补丁 / 查看 diff」按钮）。
- **右栏是跟随当前会话的 diff / 审查面板**，底部可直接 commit & push。

这意味着工程范围 = 真实终端 + 会话编排 + AI 集成 + Git 集成。设计稿只规定「呈现」，不含后端逻辑。

### 1.3 布局与尺寸（来自 README + HTML 实测）

```
┌──────────────────────────────────────────────────────────────┐
│ 标题栏 height:48px  bg:#fbfbfc  下边框 1px #ededf0             │
│ 🔴🟡🟢  [折叠侧栏]  [Tab orbit⎇main][orbit⎇pay][web⎇main][+]  …  [+−审查][🔔²] │
├──────────┬────────────────────────────────┬──────────────────┤
│ 侧边栏    │ 终端主区  flex:1  bg:#fff       │ 审查/diff 面板    │
│ 272px    │                                │ 300px            │
│ #f7f7f8  │ padding:20px 24px              │ #f7f7f8          │
│          │ 13px / line-height 1.85         │                  │
│ [+新建终端│ JetBrains Mono                  │ 头40px「改动」    │
│  |✦Agent]│                                │ 文件卡 + mini diff│
│ [搜索会话]│ ❯ shell 流 …                    │                  │
│          │ ┃ 内联AI回复块(左2px #c2683c)    │ ─────────        │
│ ~/orbit 3│ ┃ [应用补丁][查看diff]           │ commit 输入框     │
│  •会话卡  │                                │ [提交][提交并推送]│
│  •会话卡  │ ❯ 输入 ▏(闪烁光标)              │ origin/branch    │
│ ~/web  1 │                                │                  │
│  •会话卡  ├────────────────────────────────┤                  │
│ ~/infra 1│ 状态栏 height:30px bg:#fbfbfc    │                  │
│  •会话卡  │ path · ⎇branch · node · UTF-8   │                  │
│ ─────    │                                │                  │
│ ⚙设置 5会话│                                │                  │
└──────────┴────────────────────────────────┴──────────────────┘
```

- 全窗口竖向 flex：标题栏(48px, flex:none) + 主体(flex:1, 横向三栏)。
- 侧边栏（272px）与审查面板（300px）**均可隐藏**（标题栏左按钮 / 右侧 `+−` 按钮）。
- 弹层（新建 Agent 520px / 设置 600px）为绝对定位居中 sheet + 半透明遮罩 + blur。

### 1.4 Design Tokens（实现时直接抄成 CSS 变量）

**颜色**
- 强调（Terracotta）：`#c2683c`；浅底 `#fbeadf` / `#fbf6f2`；边 `#f1d6c6`
- 文字阶：`#27272a`(主) `#3f3f46` `#52525b` `#71717a` `#a1a1aa` `#b4b4bc` `#c4c4cc`
- 面/底：`#ffffff` `#fbfbfc` `#f7f7f8` `#efeff1`；hover `#f0eff2`
- 线：`#ededf0` `#e6e6e9` `#f1f1f3`
- 语义：成功 `#2f9e7a`(底 `#dff2ea`/`#e8f6ef`) / 失败 `#e0556b`(底 `#fdf4f5`/`#fbe1e5`) / 警告 `#e2c08d`
- agent：CC `#c2683c` · CX `#2f9e7a` · CU `#4f6ef0`
- **shell 专属配色**（刻意区别于 UI 灰阶）：路径蓝 `#2563eb` · 提示符`❯`/PASS 绿 `#16a34a` · 错误/FAIL 红 `#dc2626`
- diff：删 底`#fcebec`/字`#c0414e` · 增 底`#e8f6ef`/字`#1f8a5b`

**字体**：UI 用 `-apple-system, system-ui`；所有终端/代码/路径/分支/快捷键用 `'JetBrains Mono'`（400/500/600/700，Google Fonts）。尺寸：标题16 / 区块13.5 / 正文13 / 次要12–12.5 / meta 10.5–11.5 / 角标9。

**圆角**：按钮/输入 7–8；卡片/标签 9；弹层 14；角标 6；胶囊 100px。
**间距**：卡内 padding 10–11；区栏 padding 14；gap 8–10。
**阴影**：卡 `0 1px 2px rgba(0,0,0,0.03)`；弹层 `0 30px 80px rgba(20,20,30,0.4)`；通知 `0 16px 40px rgba(20,20,30,0.18)`。

**动画**（HTML 第 17–21 行已给关键帧）：
- `blink` 1.1s steps(1) — 光标闪烁
- `pulseDot` 1.3s — 运行中会话呼吸点
- `toastIn` .3s — 通知滑入
- `fadeIn` .2s — 遮罩
- `sheetIn` .24s — 弹层入场（translate + scale .985→1）

### 1.5 前端状态模型（HTML 第 463–504 行，直接照搬）

```ts
state = {
  active: 'auth',        // 当前会话 id
  sidebar: true,         // 侧栏显隐
  panel: true,           // 审查面板显隐
  overlay: null,         // null | 'agent' | 'settings'
  notif: false,          // 通知中心开关
  pick: 'CC',            // 新建 Agent 选中的 agent
  theme: 'light',        // 'light' | 'dark' | 'system'（dark 本期不实装）
}

// 每个会话的数据形状（原型里是静态 mock，生产要换成真实数据）
session = {
  id, title, dir, branch,
  agent: 'CC'|'CX'|'CU',
  status: 'running'|'fresh'|'done',  // 对应：呼吸点 / 勾「刚完成」/ 灰点 exit 0
  cmd, reply,                         // 内联 AI 块内容
  changes: bool, summary, commit,     // diff 面板：摘要 + commit 建议
}
```

**会话状态 → 视觉映射**：
- `running`：`#c2683c` + 脉冲呼吸点 + 额外一条 3px 进度条（轨 `#f0eae6` / 填 `#c2683c`）
- `fresh`（刚完成）：`#2f9e7a` 600 + 勾图标 + 标题右侧绿点
- `done`（exit 0）：`#9aa0a6` + 静止灰点

### 1.6 交互清单（验收用）

- **会话切换**：点侧栏卡 / 点 Tab → 更新激活高亮 + 终端流 + 状态栏 path/branch + 审查面板。**始终恰好一个 Tab 激活**；点击不在固定 Tab 中的历史会话时，动态生成一个高亮 Tab（HTML `isExtra` 逻辑）。
- **新建终端**：即时，无弹层（侧栏「+新建终端」/ `⌘T`）。
- **新建 Agent**：弹层（侧栏「✦Agent」/ Tab 区 `+`），选目录 + 选 agent。
- **折叠侧边栏**：标题栏左按钮。
- **审查面板开关**：标题栏 `+−` 或终端内「查看 diff」。
- **通知中心**：铃铛开关，失败项（红，持久）+ 完成项（绿），角标计数 = 未读数。
- 所有图标按钮 hover `#f0eff2`。

### 1.7 设置弹层

子标签：外观[选中] / 字体 / Agents / 快捷键。
- **主题**：3 张迷你窗口预览卡（浅[选中]/深/跟随系统），选中=卡内 2px `#c2683c` 边 + 实心单选点。深色本期**只切选中态，不实装**。
- **强调色**：5 个色环，琥珀选中（双环高亮）。
- **终端 → 光标样式**：竖条[选中]/方块/下划线分段控件。
- 底：「更改即时生效」。

---

## 第二部分：终端核心可复用性调研

### 2.1 候选项目对比

| 项目 | Stars | 最近更新 | Tauri | License | 价值 |
|------|-------|---------|-------|---------|------|
| **`emee-dev/terax-ai-tauri-terminal`** | 0(新) | 2026-05 | **v2** | **Apache-2.0** ✅ | **最佳蓝本**，下详 |
| `Tnze/tauri-plugin-pty` | 19 | 2026-06 | v2 | ❌ 无 LICENSE | 思路参考（插件化封装） |
| `Shabari-K-S/terminon` | 0 | 2026-01 | v2 | ❌ 无 LICENSE | 多 Tab/split 思路参考 |
| `marc2332/tauri-terminal` | 125 | 2023(旧) | v1 | ❌ 无 LICENSE | 仅最小示例，已过时 |

> **法律红线**：GitHub 上**无 LICENSE 文件 = 默认保留所有权利**，即便公开也不授予复制/修改/分发权。terminon / tauri-plugin-pty / tauri-terminal **三者均无 license**，只能「看思路、自己重写」，**不能拷贝代码**。唯一可合法复用源码的是 **terax（Apache-2.0）**。

### 2.2 结论：终端部分「能否直接用」？

**能——以 terax 为蓝本复用，而不是从零写。** 它已经实现了本项目最难、最容易出 bug 的几块，且代码是生产级（有详尽注释、处理了真实世界边界情况）：

| Conduit 需要的能力 | terax 是否已实现 | 对应文件 |
|---|---|---|
| 多 PTY 会话并发管理 | ✅ `HashMap<u32, Arc<Session>>` + 单调 id | `src-tauri/src/modules/pty/mod.rs` |
| 高频输出不打爆 IPC | ✅ reader/flusher/waiter 三线程 + 8ms 批量 | `pty/session.rs` |
| 背压（cat 大文件不崩） | ✅ 4MiB 上限，溢出整块丢 + ESC c 硬重置 | `pty/session.rs` |
| 防僵尸进程 | ✅ `Drop` 兜底 kill（窗口崩溃/HMR） | `pty/session.rs` |
| 切 Tab 保活后台进程 | ✅ 会话 by-id，前端切显示不杀进程 | 前端 + mod.rs |
| cwd / 命令边界跟踪 | ✅ OSC 7 + OSC 133 A/B/C/D，兼容 zsh/p10k/starship | `pty/shell_init.rs` + `scripts/` |
| 文件树 | ✅ `fs_read_dir`（目录优先、过滤隐藏） | `fs/tree.rs` |
| 文件搜索/grep | ✅ `fs_search` / `fs_grep` / `fs_glob`（ignore + ripgrep 库） | `fs/grep.rs` |
| 自定义标题栏（macOS） | ✅ `TitleBarStyle::Overlay` | `lib.rs` + `WindowControls.tsx` |
| xterm + WebGL/fit/search/links | ✅ | `useTerminalSession.ts` |
| AI 内联渲染组件 | ✅ `ai-elements/`（message/code-block/reasoning…）+ `@ai-sdk/anthropic` | `components/ai-elements/` |

### 2.3 terax 后端核心实现（带评注）

**多会话状态（`pty/mod.rs`）** —— 教科书式的标准解：
```rust
pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    next_id: AtomicU32,  // 从 1 起，单调递增，永不复用
}
// 命令：pty_open(cols,rows,cwd,channel)->id / pty_write(id,data) /
//       pty_resize(id,cols,rows) / pty_close(id)
```

**三线程数据流（`pty/session.rs`）** —— 解决「高频输出 + UTF-8/CSI 完整性」：
```
PTY master ──read──> [reader 线程] ──> pending Vec<u8> (Mutex)
                                          │
                          [flusher 线程] 每 8ms 取走整块 ──base64──> Channel<PtyEvent> ──> 前端
                          [waiter 线程] child.wait() ──> Exit{code} ──> Channel
```
关键设计决策（直接采纳，别自己重踩）：
- **批量 flush（8ms）**而非逐字节 emit——否则 `yes` / `cat 大文件` 会把 IPC 打爆。
- **背压溢出整块丢 + `\x1bc` 硬重置**——绝不切断半个 CSI 转义序列（否则 xterm 屏幕状态错乱）。
- **base64 over `Channel<T>`**——Tauri v2 的 Channel 走 JSON，`Vec<u8>` 会变成 int 数组膨胀 3 倍；base64 仅 +33%，本地 IPC 可忽略。

**shell 集成（`pty/shell_init.rs`）**：把 OSC 7 / OSC 133 标记注入临时 rc 文件（原子写 tmp+rename），保留用户 ZDOTDIR，每次 prompt 重注入以兼容 p10k/starship。→ Conduit 状态栏的 path/branch、未来 block 化都依赖它。

### 2.4 terax 前端接线（`pty-bridge.ts`，干净可直接照搬接口）

```ts
import { invoke, Channel } from "@tauri-apps/api/core";
export async function openPty(cols, rows, handlers, cwd?): Promise<PtySession> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (e) => {
    if (e.type === "data") handlers.onData(decodeBase64(e.data)); // base64 -> Uint8Array
    else if (e.type === "exit") handlers.onExit?.(e.code);
  };
  const id = await invoke<number>("pty_open", { cols, rows, cwd: cwd ?? null, onEvent: channel });
  return {
    id,
    write:  (data) => invoke("pty_write",  { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close:  ()     => invoke("pty_close",  { id }),
  };
}
```
- `useTerminalSession.ts`：xterm 实例 + `FitAddon`/`SearchAddon`/`WebLinksAddon`/`WebglAddon`，`cursorStyle:'bar'`（= Conduit 默认「竖条」），scrollback 5k 行（≈6MB/Tab），并注册 OSC handler（cwd / prompt tracker）+ 自动识别本地 dev URL。
- `TerminalPane` / `TerminalStack`：多会话容器，切换 = 切显示，进程保活。

### 2.5 依赖清单（terax，已验证可对齐 Conduit）

**Rust（`src-tauri/Cargo.toml`）**
```toml
tauri = { version = "2" }
portable-pty = "0.9"
base64 = "0.22"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
log = "0.4"
ignore = "0.4"            # 文件树/搜索 gitignore 感知
grep-regex / grep-searcher / grep-matcher = "0.1"   # 内置 ripgrep
globset = "0.4"
tauri-plugin-{log,os,store,process} = "2"
```
**前端（`package.json` 摘选）**
```jsonc
"@tauri-apps/api": "^2",
"@xterm/xterm" + "@xterm/addon-{fit,search,web-links,webgl}",
"@fontsource/jetbrains-mono",   // 离线字体（比 Google Fonts 可靠）
"@ai-sdk/anthropic" / "@ai-sdk/react" / …  // AI 集成（按需裁剪）
```

---

## 第三部分：落地建议

### 3.1 推荐路线

1. **fork / 拉取 terax** 作为脚手架基线（Apache-2.0，保留其 NOTICE/LICENSE 与版权头）。
2. **保留并复用**：整个 `src-tauri/src/modules/pty`、`fs`、shell 集成、xterm 接线层（`pty-bridge` / `useTerminalSession` / `osc-handlers`）、`WindowControls`。这是「终端核心」，不重写。
3. **替换前端外壳**：删掉 terax 自带的 UI，按 Conduit 设计稿（§1.3–§1.7）用 React 重写三栏 + 弹层 + 通知中心 + diff 面板。terax 是 React 19 + Tailwind v4，与 Conduit 复刻天然兼容。
4. **新增 Conduit 特有逻辑**：
   - 会话编排（按目录分组、状态机 running/fresh/done、进度条）。
   - **AI agent 接入**：CC/CX/CU 的实际调用 + 内联回复块（terax 已有 `ai-elements` 与 ai-sdk，可借）。
   - **Git 集成**：diff 面板的 `git status`/diff 解析、commit & push（terax **没有**，需自建，建议 Rust 端封 `git2` 或调 `git` CLI）。

### 3.2 难度分级（基于已确认的代码现状）

| 模块 | 难度 | 说明 |
|---|---|---|
| 三栏静态外壳 + tokens + 弹层 | ⭐⭐ | 纯前端，照设计稿复刻 |
| 终端核心（多会话/背压/shell 集成） | ⭐ **几乎白送** | terax 已实现，直接用 |
| 会话编排 + 状态机 + 进度条 | ⭐⭐⭐ | 需自建数据层与状态同步 |
| Git 集成（diff/commit/push） | ⭐⭐⭐ | terax 无，需自建（git2 / CLI） |
| AI agent 真实接入 + 内联块 | ⭐⭐⭐⭐ | 最不确定项；需定义 agent 协议、流式渲染、「应用补丁」回写 |

**总评**：之前担心的两个终端难点（多 PTY 并发、IPC 背压）已被 terax 解决，**项目重心从「造终端」转移到「会话编排 + AI/Git 集成 + UI 复刻」**。真正的工作量与风险在 AI agent 接入（§3.1 第 4 条最后一项）。

### 3.3 待决事项（需产品/你拍板）

1. **AI agent 如何接**：是调各 agent 的 CLI（claude/codex/cursor）还是直接调 API？「应用补丁」是 agent 产出 patch 由我们 apply，还是 agent 直接写盘？——决定 §3.2 最后一行的真实难度。
2. **是否 fork terax**：接受 Apache-2.0 依赖与其代码风格（React19/Tailwind4/ai-sdk），还是只读它的实现、用自己的栈重写后端。
3. **Git 集成选型**：Rust `git2`（libgit2 绑定，无需系统 git）vs 调 `git` CLI（简单但依赖环境）。
4. **多窗口 vs 单窗口多 Tab**：Conduit 设计是单窗口 + Tab；terax 的设置走独立 window。

### 3.4 文档审阅意见（2026-06-18）

> 角色：对本调研稿做落地前 review。以下是建议修改项，不直接覆盖原调研脉络，便于后续按优先级修订。

| 优先级 | 位置 | 修改意见 |
|---|---|---|
| P0 | §3.3 待决事项 | 本节已被《调研-三大难点深入.md》的 D1-D6 决策覆盖。建议改名为「历史待决项」，或直接替换为「已拍板决策摘要 + 链接到决策记录」，避免读者误以为 AI 接入、push、历史恢复仍未定。 |
| P0 | §3.2 AI agent 难度 | 本稿仍把「AI agent 真实接入 + 内联块」标为 ⭐⭐⭐⭐，但后续深挖已降为 ⭐⭐⭐。建议同步为「工程量大但无阻断未知」，并把真实风险改成 CLI 字段漂移、权限/登录预检、进程清理与超时。 |
| P1 | §1.6 / §1.7 「应用补丁」 | 后续 D1 已决定 agent 直接写盘，原型里的「应用补丁」按钮语义会误导。建议改成「已应用」状态或只保留「查看 diff」；若坚持保留「应用补丁」，就必须重新设计 patch 产出、校验、apply/rollback 流程。 |
| P1 | §2.1 / §2.2 terax 复用 | 「直接照搬」需要落成合规清单：保留 Apache-2.0 LICENSE/NOTICE/版权头，记录 vendored 路径和改动范围，新增 `THIRD_PARTY_NOTICES.md`；无 LICENSE 的候选项目只能看思路，不能复制代码片段。 |
| P1 | §2.2 「生产级」表述 | terax 是 0 star 新项目，建议把「生产级」改为「实现质量较高，但需本项目 smoke 验证」。最少补测 `yes`/大文件输出、resize、中文宽字符、OSC 7/133、HMR/drop kill、窗口关闭后子进程清理。 |
| P2 | §2.5 前端依赖 | 若最终统一走三家 CLI，`@ai-sdk/*` 不应成为 MVP 硬依赖。建议把 terax 的 `ai-elements` 视为可借鉴 UI 组件，SDK 依赖标成可裁剪项，避免引入第二套云 API 接入路径。 |
| P2 | §1.3 布局尺寸 | 三栏固定宽在窄窗口会压缩终端主区。建议补一个最小宽度/响应式策略：例如 `<900px` 自动隐藏右栏，`<720px` 自动隐藏侧栏，保证 xterm 可用宽度。 |

---

## 附录：信息来源

- 设计稿：`_unzipped_design/design_handoff_conduit_terminal/`（README + Conduit.dc.html + Terminal Concepts.dc.html）
- [emee-dev/terax-ai-tauri-terminal](https://github.com/emee-dev/terax-ai-tauri-terminal)（Apache-2.0，核心蓝本）
- [Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)（无 license，思路参考）
- [Shabari-K-S/terminon](https://github.com/Shabari-K-S/terminon)（无 license，思路参考）
- [marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal)（无 license，v1 旧示例）
- [xterm.js](https://github.com/xtermjs/xterm.js)、[How Warp Works](https://www.warp.dev/blog/how-warp-works)
