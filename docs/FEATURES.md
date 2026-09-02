# 功能与代码地图

这份文档是 Tunara 的 **用户可见合同**：现在能做什么、代码在哪。它不替代产品原则或 IPC 全表。

- 产品原则与明确不做：[GOAL.md](./GOAL.md)
- IPC、传输与托管 state：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 已落地能力叙事：[ROADMAP.md](./ROADMAP.md)

当前发布版本见根目录 `package.json`（撰写时为 2.0.1）。

## 产品是什么

Tunara 是一个终端。真实 PTY / SSH；左边侧栏按项目和机器分组会话，agent 需要你时你会知道；右边检查器让你随手看一眼它改了什么。

职责是让 shell、Git、文件、Preview 和 Agent CLI 在同一个窗口里更容易观察、切换和验证。它不替代这些工具。

安装包大约 30 MB。本地终端跑真实 `portable-pty`；前端用 xterm.js 6 加 WebGL renderer。输出经 RAF 合批和双层背压（PTY 1 MiB / 前端 2 MiB），`cat` 大日志不会锁死界面。没有云、没有账号、没有埋点。

## 窗口结构

主窗口由 [`src/app/App.tsx`](../src/app/App.tsx) 组成固定三栏，外加覆盖层：

```
┌ Titlebar ─────────────────────────────────────────────────────┐
├ Sidebar ──┬ MainArea (终端 + 会话阅读面板) ┬ InspectorPanel ┤
└───────────┴───────────────────────────────────┴───────────────┘
Overlays: Settings · Command Palette · SSH 连接 · Host key
          · Keyboard-interactive · Workflow 参数 · Toast
```

| 区域 | 入口 | 职责 |
|------|------|------|
| 标题栏 | [`src/ui/Titlebar.tsx`](../src/ui/Titlebar.tsx) | 窗口 chrome。不再放终端/文件标签，也不再放设备菜单。 |
| 侧栏 | [`src/ui/Sidebar.tsx`](../src/ui/Sidebar.tsx) | 本地按目录、SSH 按主机分组的会话；顶部一行「需要你 · N」 |
| 主区 | [`src/ui/MainArea.tsx`](../src/ui/MainArea.tsx) | xterm 分栏；文件在终端旁的阅读面板打开，属于当前会话 |
| 检查器 | [`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx) | 按会话状态自动选择 Changes / Files / Preview，以及 SSH 专用 Transfers / Forwarding。Auto/Locked 行为保留，界面上没有标签和按钮。 |

窄窗口时侧栏和检查器改为覆盖层，优先保证终端可用宽度。布局按终端列宽预算决定是否停靠，见 [`src/app/lib/app-shell-layout.ts`](../src/app/lib/app-shell-layout.ts)。

没有独立的 Pure Mode。终端聚焦时 chrome 自动淡化（侧栏、检查器、标题栏降到约 60% 不透明度，避免终端列宽重排）。真正收起侧栏 / 检查器仍是 ⌘\ / ⌘⇧\。

---

## 1. 终端

**用户能做什么：** 多会话真实 PTY；最多 4 个递归分栏；⌘F 搜索（正则 / 大小写）；命令块导航、复制与导出；可点击链接；行内图片（SIXEL / iTerm IIP，始终启用）；跨重启恢复 10000 行 scrollback。没有命令块输出过滤器。

| 能力 | 说明 | 代码 |
|------|------|------|
| 本地 PTY | `portable-pty` 登录壳，输出经 Channel 推送 | [`src-tauri/src/modules/pty/`](../src-tauri/src/modules/pty/) · [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| xterm 渲染 | xterm.js 6 + WebGL，RAF 合批，双层背压 | [`TerminalView.tsx`](../src/ui/TerminalView.tsx) · [`terminal-output-buffer.ts`](../src/modules/terminal/lib/terminal-output-buffer.ts) |
| 输出确认 | 前端 ACK 驱动 SSH/本地流控 | `pty_output_ack` |
| 分栏 | 在任意 pane 右/下继续拆，最多 4 pane | [`split-layout.ts`](../src/modules/session/split-layout.ts) |
| 搜索 | ⌘F，匹配计数，正则 / 大小写 | [`useTerminalSearch.ts`](../src/ui/useTerminalSearch.ts) · [`TerminalSearchBar.tsx`](../src/ui/TerminalSearchBar.tsx) |
| 命令块 | 跟随 scrollback marker；⌘⇧↑ / ⌘⇧↓ 块导航；右键菜单展示退出码/耗时，可复制命令/输出、导出输出、回填命令到输入行（不自动执行）。没有 text / regex / invert / context-lines 输出过滤器。 | [`terminal-blocks.ts`](../src/modules/terminal/lib/terminal-blocks.ts) · [`useTerminalBlockMenu.ts`](../src/ui/useTerminalBlockMenu.ts) |
| 命令完成提醒 | 非观察中会话的完成 toast 附带耗时；≥15s 的长命令在窗口后台完成时请求一次 Dock 弹跳 | [`session-lifecycle.ts`](../src/modules/terminal/lib/session-lifecycle.ts) · [`background-attention.ts`](../src/ui/lib/background-attention.ts) |
| 拖放路径 | 本地会话把 Finder/文件管理器拖入的路径转义后写入输入行（不自动回车）；SSH 会话仍走 SFTP 上传 | [`shell-quote.ts`](../src/modules/terminal/lib/shell-quote.ts) · [`TerminalViewChrome.tsx`](../src/ui/TerminalViewChrome.tsx) |
| 导出滚屏/块 | 显式另存为，最多 2000 行 / 256 KiB | [`terminal-export.ts`](../src/modules/terminal/lib/terminal-export.ts) · [`fs_export_text_file`](../src-tauri/src/modules/fs/file.rs) |
| 安全粘贴 | 多行确认、bracketed paste、目标失效拒绝 | [`terminal-paste-protection.ts`](../src/modules/terminal/lib/terminal-paste-protection.ts) |
| 右键与复制 | 智能右键：空闲时打开菜单，TUI 上报时把手势交给终端；Copy / Safe Paste 可配置 | [`TERMINAL_INTERACTIONS.md`](./TERMINAL_INTERACTIONS.md) |
| 会话恢复 | serialize 快照 + 安全历史 | [`terminal-snapshot.ts`](../src/modules/terminal/lib/terminal-snapshot.ts) |
| OSC | OSC 7 cwd、OSC 133 命令边界、OSC 8 链接、OSC 9 / 99 / 777（解析后丢弃提醒，避免与 Agent 确认抢注意力）、OSC 9;4 进度、OSC 52 剪贴板 | [`src/modules/terminal/lib/`](../src/modules/terminal/lib/) |
| 行内图片 | SIXEL / iTerm IIP | [`terminal-image.ts`](../src/modules/terminal/lib/terminal-image.ts) |
| 配色 | 界面与终端同步：System / Light / Dark | [`useTerminalRuntimeSync.ts`](../src/ui/useTerminalRuntimeSync.ts) |

分栏默认快捷键：⌘D 水平、⌘⇧D 垂直；焦点按几何方向 ⌘[ / ⌘] / ⌘⇧[ / ⌘⇧]。

---

## 2. 会话侧栏

**用户能做什么：** 本地按工作目录分组，SSH 按目标主机分组；置顶、重命名、模糊搜索（含主机名）；关闭 running 会话需二次确认；选择目录新建终端；在已连接主机上再开窗口。

侧栏顶部是一行「需要你 · N」（⌘↩ 跳转）。会话卡片只有一个状态点。Dock 角标与这一行同源。

| 能力 | 代码 |
|------|------|
| 会话列表与分组 | [`Sidebar.tsx`](../src/ui/Sidebar.tsx) · [`sidebar-groups.ts`](../src/modules/session/sidebar-groups.ts) · [`SessionCard.tsx`](../src/ui/SessionCard.tsx) |
| 会话状态机 | [`src/state/sessions.ts`](../src/state/sessions.ts) · [`session-lifecycle.ts`](../src/modules/terminal/lib/session-lifecycle.ts) |
| 「需要你 · N」 | [`GlobalAgentBar.tsx`](../src/ui/GlobalAgentBar.tsx) · [`session-attention.ts`](../src/modules/session/session-attention.ts) |
| 跳到需要你的会话 | ⌘↩，只聚焦，不自动跑命令。[`session-attention.ts`](../src/modules/session/session-attention.ts) · [`useKeybindings.ts`](../src/app/useKeybindings.ts) |
| 选择目录新建 | [`new-terminal-directory.ts`](../src/modules/session/new-terminal-directory.ts) |
| 空状态（选目录主 CTA、最近目录；无历史时扫描附近 git 仓库一键开终端；关光会话不再偷偷建 `~`） | [`WorkspaceEmptyState.tsx`](../src/ui/WorkspaceEmptyState.tsx) · [`recent_repos.rs`](../src-tauri/src/modules/fs/recent_repos.rs) |
| Agent 等待确认（窗口不在前台） | Dock 弹跳一次 + 角标；同一等待不重复。不发系统通知。[`background-attention.ts`](../src/ui/lib/background-attention.ts) · [`useDockBadge.ts`](../src/app/useDockBadge.ts) |
| 目录组 | 折叠 / 展开 / 批量关闭；拖拽排序 |
| 关闭确认 | running 会话需要二次确认，避免误关跑到一半的任务 |
| 置顶 | 星标；命令面板的会话结果里排得更靠前 |
| 跨重启 | 恢复会话列表和 UI 布局，见 [STATE_AND_PERSISTENCE.md](./STATE_AND_PERSISTENCE.md) |

工作区快照恢复会话列表、布局、终端 scrollback 和 Agent resume 意图。

---

## 3. 检查器（右栏）

检查器默认跟随当前会话：有未审阅 Git 改动时显示 Changes；用户已打开 Preview 时显示 Preview；SSH 传输进行中显示 Transfers；其余显示 Files。手动选择会锁定，直到切换会话或回到自动。界面上没有 Auto / Locked 标签和按钮；行为仍按 [`inspector-context.ts`](../src/ui/inspector-context.ts) 工作。可用视图由 [`inspector-navigation.ts`](../src/ui/inspector-navigation.ts) 按本地/SSH 裁剪。一次只挂载当前视图。作用域（全局 / profile / 会话 / 传输绑定）见 [`inspector-scope.ts`](../src/ui/inspector-scope.ts)。

终端上方没有 SSH / Preview / Changes 提示条。需要你的会话走侧栏「需要你 · N」；改动在检查器 Changes 里看。

| 视图 | 范围 | 内容 | 入口 |
|------|------|------|------|
| Changes | 仓库 profile | 只读 staged / unstaged / untracked | [`DiffPanel.tsx`](../src/ui/DiffPanel.tsx) |
| Files | 传输绑定 | 目录树、搜索、预览、SSH 传输 | [`FileExplorer.tsx`](../src/ui/FileExplorer.tsx) · [`FilePreview.tsx`](../src/ui/FilePreview.tsx) |
| Preview | 会话 | workspace-bound WebView；用户打开后才自动跟随 | [`PreviewPanel.tsx`](../src/ui/PreviewPanel.tsx) |
| Transfers | SSH | 上传/下载进度、取消、恢复 | [`TransferCenter.tsx`](../src/ui/TransferCenter.tsx) |
| Forwarding | SSH 绑定 | 本地/动态/反向端口转发 | [`ForwardingPanel.tsx`](../src/modules/ssh/ForwardingPanel.tsx) |

远端文件属性在 Files 右键弹窗中展示（[`RemoteMetadataPanel.tsx`](../src/modules/ssh/remote-fs/RemoteMetadataPanel.tsx)）。连接诊断保留独立故障处理路径，known_hosts 在设置。交互模型见 [INSPECTOR_PANELS.md](./INSPECTOR_PANELS.md)。⌘K 可直达全部视图。

---

## 4. SSH

**用户能做什么：** 长连接远程壳、主机 profile、TOFU 主机密钥、SFTP 浏览、远程 Git review、可选 shell 集成、端口转发、传输与诊断。密码和口令只在单次连接内存中使用，不写入 profile 或快照。远程会话走 russh 长连接，不是包一层 `/usr/bin/ssh`。

连接 UI 是一个 `user@host` 输入框，回车即连。认证自动尝试；失败后才展开高级项。连上后自动保存主机。

| 能力 | 说明 | 代码 |
|------|------|------|
| 打开会话 | 当前路径走 `ssh_open_v2`（含 transport generation）；`ssh_open` 为兼容适配器 | [`src-tauri/src/modules/ssh/`](../src-tauri/src/modules/ssh/) · [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| 连接 UI | `user@host` 回车即连；失败后展开 Agent / 私钥 / 密码 / keyboard-interactive、ProxyJump | [`SshConnect.tsx`](../src/ui/overlays/SshConnect.tsx) |
| 主机 profile | 无凭证；成功后自动保存；可从 `~/.ssh/config` 导入静态 Host | [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| 服务器列表 | 搜索保存主机与 SSH config 主机，按真实会话状态筛选在线/离线；提供 Connect / Open terminal / Edit | [`SshHostsDashboard.tsx`](../src/ui/SshHostsDashboard.tsx) |
| 主机密钥 | TOFU；`unknown` 可持久化，`unverifiable` 不写入 | `ssh_host_key_decision` · [`HostKeyPrompt.tsx`](../src/ui/overlays/HostKeyPrompt.tsx) |
| 远程 Git | 一次性 exec channel，不占交互壳 | `ssh_git_*` · [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| 远程搜索 | 文件名 / grep，可取消，LRU 缓存 | `ssh_fs_search` / `ssh_fs_grep` |
| 安全写 | fingerprint 冲突检测、断线 reconcile | [`safe_write.rs`](../src-tauri/src/modules/ssh/safe_write.rs) |
| 远端变更 | mkdir / rename / delete，带前置条件 | `ssh_fs_mutate_v1` · [`remote-fs/`](../src/modules/ssh/remote-fs/) |
| 传输 | 单文件与批量上传/下载、进度、取消、journal 恢复 | [`transfer/`](../src-tauri/src/modules/ssh/transfer/) · [`transfer-store.ts`](../src/modules/ssh/transfer-store.ts) |
| 转发 | 本地端口转发与动态转发；重连快照 | `ssh_local_forward_*` / `ssh_dynamic_forward_*` |
| 诊断 | 显式运行/取消的配置与连接诊断 | `ssh_diagnostic_*_v1` |
| 远程 shell 集成 | 可选远程 bash/zsh，用于 cwd、命令边界和 agent 状态 | [`src-tauri/src/modules/ssh/`](../src-tauri/src/modules/ssh/) |

认证与路由边界写在 SSH 连接界面文案里：不执行 `ProxyCommand` / `Match exec`；不支持 Windows agent 与原生 FIDO/PKCS#11。

---

## 5. 文件、预览与轻编辑

本地与 SSH 共用 Files 表面。打开的文件不再作为标题栏工作区标签；它们在终端旁边的 **阅读面板** 里打开，属于当前会话。阅读面板支持 ‹ › 历史；SSH 断线后自动恢复；大文件可「跟随末尾」。

| 能力 | 边界 | 代码 |
|------|------|------|
| 目录浏览 | 本地锁在工作区；SSH 从远端 `/` 浏览，主目录/cwd 是快捷位置 | [`FileExplorer.tsx`](../src/ui/FileExplorer.tsx) |
| 文本预览/编辑 | UTF-8、≤256 KiB、fingerprint 原子写 | [M2_MARKDOWN_SAFE_EDITING.md](./M2_MARKDOWN_SAFE_EDITING.md) |
| Markdown / MDX | 惰性阅读；MDX 当静态源码，不执行 | [`FilePreview.tsx`](../src/ui/FilePreview.tsx) |
| Notebook / Excel | 只读 `.ipynb`（不执行、不渲染 HTML/脚本/富输出）与只读表格预览 | [`notebook.ts`](../src/modules/editor/notebook.ts) · [`tabular-preview.ts`](../src/modules/editor/tabular-preview.ts) |
| 图片预览 | 安全解码常见图片；超大像素拒绝 | `ReadResult.kind = "image"` · [`fs/file.rs`](../src-tauri/src/modules/fs/file.rs) |
| 大文本 | 显式查看；最多 2000 行 / 256 KiB；阅读面板可跟随末尾 | [LIMITED_LARGE_FILE_VIEWING.md](./LIMITED_LARGE_FILE_VIEWING.md) |
| 外部编辑器 | 本地路径跳 VS Code / Cursor / Zed / Sublime | [`open.ts`](../src/modules/editor/open.ts) |
| 资源引用 | 远程路径不得落到本地编辑器 IPC | [`resource-ref.ts`](../src/modules/resources/resource-ref.ts) |
| 阅读面板 | 分屏、属于会话、‹ › 历史、SSH 断线自动恢复 | [`FilePreview.tsx`](../src/ui/FilePreview.tsx) · [`src/ui/MainArea.tsx`](../src/ui/MainArea.tsx) |

标题栏设备标签合同的历史说明见 [TITLEBAR_DEVICE_TABS.md](./TITLEBAR_DEVICE_TABS.md)；当前产品不再用标题栏打开文件。

---

## 6. Git review

右栏 Changes 是 **只读** diff，给你「在 commit 之前再看一眼」。读走 git2（本地）或 SSH exec（远程）；写永远走系统 `git` CLI。**Tunara 不会 stage / commit / push。**

| 能力 | 代码 |
|------|------|
| 状态 / diff / ahead-behind | [`git-bridge.ts`](../src/modules/git/git-bridge.ts) · [`src-tauri/src/modules/git/`](../src-tauri/src/modules/git/) |
| workspace / worktree 身份 | common git dir，本地与 SSH 同形状 | [`workspace-context.ts`](../src/modules/git/workspace-context.ts) |
| 文件监视 | refcount watcher，`git-changed` 事件 | [`git-watcher.ts`](../src/modules/git/git-watcher.ts) |
| 大 diff | 虚拟滚动、按展开加载、取消过期请求 | [`diff-virtual.ts`](../src/ui/lib/diff-virtual.ts) |
| 三段布局 | Staged / Unstaged / Untracked | [`DiffPanel.tsx`](../src/ui/DiffPanel.tsx) |
| 外部编辑器 | 一键跳 VS Code / Cursor / Zed / Sublime | [`open.ts`](../src/modules/editor/open.ts) |
| 降级 | 二进制 / 超大文件友好降级 | [`DiffPanel.tsx`](../src/ui/DiffPanel.tsx) |

---

## 7. Agent 识别

只识别四个一等公民：Claude Code、Codex、Cursor、OpenCode；具体生命周期与 resume 能力因 CLI 而异。数据源是 [`registry-data.json`](../src/modules/agent/registry-data.json)。其他 coding agent 按普通终端进程处理。

Tunara **认出谁在跑**，不启动、不编排、不解析私有 stdout、不保存持久 Agent 历史、不内置 AI 聊天。详情与新增清单：[AGENT_DETECTION.md](./AGENT_DETECTION.md)。

需要你时走侧栏「需要你 · N」和同源 Dock 角标，不走终端上方提示条。

---

## 8. Preview

检查器 Preview 页控制独立的 loopback WebView：来源绑定到 repository / worktree / session / terminal generation；支持导航、安全重启准备和显式 SSH tunnel。不自动扫端口，不自动启动服务，独立 Preview 窗口没有 app command 权限。合同见 [PHASE3_PREVIEW_SOURCE_CONTRACT.md](./PHASE3_PREVIEW_SOURCE_CONTRACT.md)。

终端上方没有「打开 Preview」提示条。Preview 从检查器或 ⌘K 打开。用户打开过 Preview 后，自动跟随才会选中该视图。

代码：[`src-tauri/src/modules/preview.rs`](../src-tauri/src/modules/preview.rs) · [`preview-window.ts`](../src/modules/preview/preview-window.ts) · [`PreviewPanel.tsx`](../src/ui/PreviewPanel.tsx)。

---

## 9. 设置与快捷键

设置是单页，没有页签（[`Settings.tsx`](../src/ui/overlays/Settings.tsx)）。覆盖界面+终端配色（System / Light / Dark）、语言、字体、光标、读屏、外部编辑器、SSH known_hosts、应用更新、全局唤起、Agent CLI 路径与预检。

快捷键改配置文件 `~/.config/tunara/config.toml`，设置里不再有快捷键编辑器。字号只用 ⌘+ / ⌘-（⌘0 重置）。配置经 [`config-bridge.ts`](../src/modules/config/config-bridge.ts) 读写。

命令面板：[`CommandPalette.tsx`](../src/ui/overlays/CommandPalette.tsx)，加权模糊匹配，覆盖动作与会话切换，包括打开当前会话的改动 / 文件 / Preview。

默认快捷键（macOS；Windows/Linux 实验构建见配置文件，部分默认避开裸 Ctrl）：

| 动作 | 默认 |
|------|------|
| 新建终端 | ⌘T（备选 ⌘N） |
| 关闭会话 | ⌘W |
| 分栏 | ⌘D / ⌘⇧D |
| 切换 pane | ⌘[ ⌘] ⌘⇧[ ⌘⇧] |
| 命令面板 | ⌘K |
| 终端搜索 | ⌘F |
| 会话 1–8 / 最后一个 | ⌘1–8 / ⌘9 |
| 最近会话循环 | ⌘Tab |
| 命令块导航 | ⌘⇧↑ / ⌘⇧↓ |
| 跳到「需要你」 | ⌘↩ |
| 字号 +/- / 重置 | ⌘+ / ⌘- / ⌘0 |
| 侧栏 / 检查器 | ⌘\ / ⌘⇧\ |
| 设置 | ⌘, |
| 全局唤起 | ⌘⇧T（可关） |

完整动作表：[`keybindings.ts`](../src/modules/config/keybindings.ts)。没有 Pure Mode（⌘⇧P）。

---

## 桌面体验

- Light / Dark / 跟随系统，陶土强调色
- 实色纸面层级 + macOS 原生覆盖标题栏
- Toast：退出动画、hover 暂停、进度条
- 低打扰的签名更新提醒：仅在确有新版本时出现
- 右键菜单覆盖会话、目录组、文件
- 响应式布局：终端可用宽度不足时，侧栏/检查器改为覆盖层
- 窗口状态持久化（位置、尺寸）
- 终端聚焦时 chrome 自动淡化；⌘\ / ⌘⇧\ 真正收起侧栏 / 检查器

---

## 代码地图

### 前端 `src/`

| 目录 | 职责 |
|------|------|
| `app/` | 入口、初始化、快捷键、主题、壳层布局 |
| `modules/terminal/` | xterm 会话、OSC、粘贴、快照、Agent 生命周期解析 |
| `modules/ssh/` | 主机、SFTP、传输、转发、诊断、远端变更 |
| `modules/fs/` · `git/` · `agent/` · `editor/` · `preview/` | 各域 IPC 桥与纯逻辑 |
| `modules/session/` | 分栏、注意力、选目录新建 |
| `modules/config/` · `i18n/` · `resources/` | 配置、文案、资源引用 |
| `state/` | Zustand：`sessions` · `ui`；`persist` 只做快照 I/O |
| `ui/` | 壳层组件与 overlays |
| `styles/` | design tokens 与终端/外壳配色 |

组件 **从不** 直接写 Tauri 命令字符串；一律走对应 `*-bridge.ts`。

### 后端 `src-tauri/src/modules/`

| 模块 | 职责 |
|------|------|
| `pty/` | 本地 PTY、输出合批、ACK 流控 |
| `ssh/` | russh 连接、SFTP、传输 journal、转发、远程 Git、诊断 |
| `fs/` | 本地目录、读写、grep、受限 head |
| `git/` | git2 只读 + watcher |
| `agent/` | hooks socket、wrapper、preflight |
| `preview/` | Preview WebView 与 tunnel |
| `resolver/` · `editor/` · `process/` | CLI 路径、外部编辑器、子进程 |

命令注册中心：[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs)。

### 测试

三套门：`tests/*.test.mjs`（纯逻辑）、`tests/ui/`（happy-dom 组件）、Rust `#[cfg(test)]`。约定见 [TESTING.md](./TESTING.md)。

---

## 明确不做（实现时对照）

完整列表见 [GOAL.md](./GOAL.md)。贡献时尤其不要加入：

- 内置 AI 聊天、模型接入、MCP 编排、Agent 启动器
- 持久 Agent Event Store / 全文搜索 / 富 Timeline
- DiffPanel 的 stage / commit / push
- 插件市场、遥测回传、递归无限分栏（硬上限 4 pane）
- 命令块输出过滤器（text / regex / invert / context lines）
- 账号、云同步
