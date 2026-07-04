# Changelog

All notable changes to Tunara are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/).

## Known security advisories

- **RUSTSEC-2026-0194 / RUSTSEC-2026-0195** (`quick-xml` 读取器解析恶意 XML 时命名空间/属性无界分配导致内存耗尽 DoS) — 仅经 `tauri` → `plist` 传入，用于解析本地可信的 macOS 属性列表，非网络或攻击者可控输入。修复版 quick-xml ≥ 0.41.0，但最新 `plist` 1.9.0（已升级锁定）仍固定在 0.39.x。已在 `src-tauri/.cargo/audit.toml` 中 ignore。**等 `plist` 接入 quick-xml ≥ 0.41 后升级并移除 ignore。**
- **RUSTSEC-2023-0071** (`rsa` Marvin timing sidechannel) — pulled transitively via `russh`/`ssh-key` for RSA host-key and RSA pubkey auth. No fixed `rsa` release exists; every russh-based SSH client currently ships with this. Tunara prefers ed25519 keys (RSA is a fallback), and the attack requires an active network MITM harvesting many timing samples from an interactive desktop client. Ignored in `cargo audit` via `src-tauri/.cargo/audit.toml`. **Revisit when `rsa` ships a fix or russh exposes a build without the RSA feature.**

## [Unreleased]

## [1.10.0] - 2026-07-04

### 新功能
- 远程内容搜索：SSH 会话的文件面板现在支持按内容搜索（grep），通过一次性 exec channel 跑 `grep -rEIn`，结果形状与本地 `fs_grep` 完全一致；远端命中点击展开内置远程文件预览（本地命中仍跳外部编辑器到行）。名称/内容两种模式的切换对远程会话全部开放，结果带 LRU 缓存并随 Refresh 一起失效。

### 修复与优化
- 后端不再向 IPC 固化任何 UI 语言：审查栏的改动统计行（"N 文件 · +A −R"）改由前端按当前语言从 files 现算——此前本地路径写死中文、远程路径写死英文，英文用户看到混排。`git_status` / `ssh_git_status` 的 `StatusResult` 移除 `summary` 字段；preflight 子进程错误串（ProcessError）统一为英文，与其余后端错误一致。
- 本地文件名搜索排序质量：`fs_search` 改为先收集 5× 候选池（≤1000）再按"文件名命中优先"排序、最后截断——旧实现走到上限即停，大仓库里深层的文件名命中永远排不进前 80。
- 修复本地 `fs_grep` 响应的 serde 字段命名（`files_scanned` → `filesScanned`），此前该字段在前端始终是 undefined。
- 终端前端输出背压溢出时保留触发溢出的最新 chunk（与后端 reader 语义一致），只丢弃积压——此前连新数据一起丢；新增 node 行为测试覆盖。
- 会话笔记：在 350ms 防抖窗口内切换会话不再丢失最后一批输入（切换/卸载时冲刷未保存的编辑）。
- agent hooks 监听器为已接受的连接加 2s 读超时，挂死的客户端不再能永久阻塞单线程 accept 循环。
- 移除 persist 层四个从未被引用的死代码导出（saveSessions/loadSessions/saveUILayout/loadUILayout，约 130 行）；旧键仅作为迁移只读输入保留。
- ESLint 清零：修复全部 6 处 react-hooks/exhaustive-deps 告警（MainArea 的 git effect 改用捕获原语依赖，DiffPanel 空数组稳定化，Toast/命令面板/工作流参数弹窗/会话笔记各自按正确语义收敛依赖）。

## [1.9.0] - 2026-07-02

### 新功能
- 侧栏全局 Agent 活动条：聚合展示所有会话里 agent 的运行状态，一眼看到谁在忙。
- Agent 启动预检与 CLI 覆盖：启动 agent 前检查可执行环境，支持自定义 CLI 命令；新增 Mod+Tab 在最近会话间循环切换。
- 手动输入 `ssh …` 命令时，提示可改用内置 SSH 会话（含主机管理与文件面板）。

### 修复与优化
- 终端闲置、切换字体或主题后文字花屏：WebGL 字形纹理图集在窗口 focus/visibility 恢复及字体、主题、连字变更时显式重建，不再依赖手动调整窗口大小自愈。
- SSH 粘贴静默丢字：shell 集成改经一次性 exec channel 暂存注入，绕开 pty 规范模式的行缓冲上限；粘贴保护确认框改用原生对话框（WebView 内 `window.confirm` 是静默 no-op）。
- SSH 子系统安全加固：SFTP 传输内存上限（防 stat 谎报导致的内存耗尽）、host-key 提示文案与真实校验行为一致、下载路径 symlink 双侧校验、exec channel 全路径显式关闭。
- SSH 会话被动断开后停止向已关闭通道写入输入。
- 远端 home 目录改经 `$HOME` 解析，文件面板支持非 root 登录；agent 退出时清除侧栏运行徽标。
- 复制操作统一走共享剪贴板 helper，修正粘贴与快速选择的若干小问题。
- 搜索高亮配色跟随明暗主题；远程会话空态样式统一；字号收敛到 design token。
- 会话关闭时清理排队中的 git 状态刷新，不再遗留孤儿状态键。
- 发版后 Homebrew cask 版本与 sha256 由 CI 自动更新并直推 main，不再依赖人工合并。

## [1.8.0] - 2026-06-28

汇总 1.7.1 以来的全部变更。

### 新功能
- 全局唤起快捷键：在任意应用里按 ⌘⇧T 唤起或隐藏 Tunara 主窗口，可在设置里改键，留空即关闭，冲突时弹提示。
- SSH config 导入：从 `~/.ssh/config` 把静态 Host 块导入成已保存的主机 profile，跳过通配和 Match 块，重复导入不会产生重复项。
- 远程 Git review：SSH 会话也能看 changes 面板了，通过一次性 exec channel 读远程仓库状态和 diff，不占用交互 shell，远程没有 git 时降级为「非仓库」。
- 远程文件搜索：SSH 会话的文件面板支持按文件名搜索远程目录。
- 文件内容搜索：本地文件面板新增按内容搜索（grep），结果按文件分组，文件名/内容两种模式可切换。

### 修复与优化
- 大 diff 虚拟滚动：只渲染可见行加缓冲，超大 diff 不再卡顿，且没有引入新依赖（为守住 30 MB 安装包没用 react-window）。
- 加固会话快照持久化：notes、置顶、折叠的 diff 分区、命令用量、SSH 远程描述符、终端快照、工作流、当前会话 id 都走纯净 restore 边界做净化，脏数据丢弃而非恢复。
- 减少无谓落盘：30 秒终端快照只在 scrollback 真正变化时才写。
- 修复会话关闭后残留的孤儿终端快照，并在界面里一致地反映终端进程退出状态。
- 收紧本地 diff 与 SSH 主机解析：非法 record key、错误端口、过时运行时字段一律丢弃。
- 修复 legacy macOS 发布通道在 CI 里的包校验脚本权限。

## [1.7.2] - 2026-06-28

### Fixed
- Fixed the legacy macOS release verification script permissions so the `-legacy` DMG lane can run its bundle gate in GitHub Actions.

## [1.7.1] - 2026-06-28

### Fixed
- Hardened workspace snapshot persistence: session notes, pinned state, collapsed diff sections, command usage, SSH remote descriptors, terminal snapshots, workflows, and active session ids are now sanitized through a pure restore boundary with direct Node coverage.
- Reduced unnecessary periodic snapshot writes by only flushing the 30 s terminal snapshot backstop when terminal scrollback changed.
- Prevented orphan terminal snapshots from being captured after a session closes, and surfaced terminal process exit state consistently in the UI.
- Tightened local diff and SSH host parsing paths so unsafe record keys, malformed ports, and stale runtime fields are dropped instead of restored.

## [1.7.0] - 2026-06-26

### Added
- **SSH 客户端**：SSH 会话成为一等公民。基于 `russh` 的长连接，一条连接多路复用 channel——交互 shell 喂给终端，SFTP channel 喂给文件面板。
  - 会话：连接 + 认证（ssh-agent → 密钥文件 → 密码，**不存储任何凭证**）+ 远程交互 shell；host key 走 `~/.ssh/known_hosts` TOFU（哈希条目密钥轮换不会被静默信任）。
  - 主机管理：host profile（host/port/user/identity 路径，无密码）存入 `~/.config/tunara/hosts.toml`，可保存与重连。
  - 文件：同连接 SFTP 子系统，远程文件树 + 只读预览 + 下载（下载目标限制在用户 home 下、拒敏感目录、限 100 MiB）。不做远程编辑。
  - 可选远程 shell 集成：向远程 bash/zsh 注入轻量 bootstrap 以获得远程 cwd / 命令边界 / agent 检测；默认关闭，不支持的 shell 静默降级。
  - 本地 PTY 路径完全未改——SSH 是新增的并行后端，russh 对某服务器失败时用户仍可在本地终端敲 `ssh`。

### Changed
- `.github/workflows/release.yml`：发布拆成 direct 与 legacy 两条 macOS 安装通道。direct 要求 Developer ID 签名、公证、updater 资产与 Homebrew cask；legacy 产出带 `-legacy` 后缀的旧式手动安装 dmg，不参与 Homebrew 或自动更新。
- `scripts/verify-macos-legacy-bundle.sh`：新增 legacy 包验证，只允许 ad-hoc 手动安装包通过，并保留 bundle 结构、签名资源和系统 dylib 依赖检查。
- `cargo audit`：忽略 RUSTSEC-2023-0071（`rsa` Marvin 时序侧信道，russh 间接依赖、上游无修复），理由记录在 `src-tauri/.cargo/audit.toml`。

## [1.6.1] - 2026-06-25

### Fixed
- macOS 分发链路修复：v1.6.0 的 dmg 因 CI 静默回退到 ad-hoc 签名 + 跳过公证，触发 Gatekeeper 拦截。本版本带真实 Developer ID 签名、Apple 公证 ticket，并嵌入 hardened runtime 所需的 4 条 entitlement（JIT、未签名可执行内存、禁用库校验、继承 DYLD 环境），保证 PTY/spawn 子进程与外部编辑器跳转在 hardened runtime 下正常工作。

### Changed
- `scripts/verify-macos-release-bundle.sh`：增加 5 项硬断言（非 adhoc、TeamID 校验、4 条 entitlement、`spctl --assess`、`stapler validate`），防止"签名失败但 release 照发"的回归。

## [1.6.0] - 2026-06-25

整轮设计 review 之后的精打磨：固定槽位字号统一、agent 徽章塌色修复、token 体系收敛、IME 友好、键盘可达性、动画稳定性。

### Added
- DiffPanel 段折叠状态写入 localStorage（`tunara.diff.collapsedSections`），重开 panel 或重启应用都能保留偏好
- SplitHandle 键盘支持：方向键 ±2%、Shift+方向键 ±10%、Home/End 跳到极值、Enter/Space 居中；带 `role="separator"` + `aria-valuenow/min/max` 语义
- Titlebar tab 溢出渐隐：鼠标滚轮转横向、active tab 自动滚入视野、左右边缘 24px mask 提示有更多内容
- Sidebar 搜索清除按钮：query 非空时显示，跟 FileExplorer 搜索清除一致
- 拖拽 cursor 反馈：sidebar 卡片可拖拽时 `grab`、拖动中 `grabbing`、搜索中 `pointer`
- BlockFilterPanel 出场动画：sheetOut keyframe 配合 closing state 实现对称的入/出
- 设计 token：`--c-info` / `--c-info-bg`（信息蓝）、`--scale-press` / `--scale-press-soft` / `--scale-press-strong`（按压缩放语义）、`--sp-5: 20px`（补 16→24 断层）

### Changed
- 固定槽位字号统一：AgentStatusBar / TerminalBlocksBar / DiffPanel 段头 / FileExplorer 结果头全部收敛到 `--fs-meta` (11px)，状态切换不再有基线跳变；MainArea 状态栏 path/branch/remote 加 `lineHeight: 16px` + 统一 `fontWeight: 500`
- 5 个塌色 agent 徽章独立色相：Cursor 深石板、Droid 琥珀金、OpenCode 青、Pi 玫红、Auggie 橄榄绿（light + dark 双套），不再撞色
- TerminalSearchBar 计数器位置稳定（visibility 切换替代条件渲染），无/有匹配时不会 layout shift
- 浮层 backdrop 与 dialog 时长统一为 `--duration-normal`：Settings / CommandPalette / TerminalQuickSelect 节奏不再错位
- AgentStatusBar 出场动画从 transition+setTimeout 改成 `statusBarSlideOut` keyframe + `onAnimationEnd` 卸载，busy 状态在淡出中重新进入也能稳定接管
- SessionCard 焦点环从 `inset boxShadow`（在 accent-bg-light 上几乎不可见）改成外置 `outline`，键盘焦点终于看得见；ARIA 嵌套 button 拆除，关闭操作通过 Delete/Backspace 完成
- FileExplorer 顶部工具栏所有控件统一 26px、padding 用 `var(--sp-2)`、gap 用 `var(--sp-1)`
- 按压缩放从 0.88/0.92/0.96/0.98 四档收敛到 0.94/0.97/0.88 三档语义 token
- 关闭分栏按钮不再隐式关掉 paneB 的终端会话；改为激活 paneA 后收起分栏，避免误杀正在跑的进程

### Fixed
- CommandPalette IME 合成期间不再被 Arrow / Enter 误触发：合成中只允许 Escape 关闭，`onCompositionEnd` 手动同步 query 解决 Chromium 时序
- Settings / CommandPalette 加 `role="dialog"` + `aria-modal` + `aria-label`，屏幕阅读器现在能正确识别浮层
- Titlebar 四个图标按钮（sidebar toggle / 新建终端 / 设置 / panel toggle）补 `aria-label`、toggle 类按钮加 `aria-pressed`
- DiffPanel Rename 徽章硬编码 `#3b82f6` 换用 `--c-info` token；"文件过大"提示改用统一 `formatSize()` 与 FileExplorer 对齐
- 删除未使用的 token：`--fs-block: 13.5px`、`--ease-spring`

## [1.5.2] - 2026-06-25

### Fixed
- Fixed release CI for repositories without Apple Developer signing secrets by using ad-hoc app bundle signing without exporting empty Apple certificate environment variables.
- Added a GitHub Actions updater signing key so new release artifacts can include a signed updater manifest and signature.

## [1.5.1] - 2026-06-25

### Fixed
- Rebuilt macOS release artifacts with complete app bundle signing metadata.
- Enabled Tauri updater artifacts so GitHub releases include `latest.json`, `.app.tar.gz`, and `.sig`.
- Vendored OpenSSL for `git2` so the Apple Silicon app no longer depends on Homebrew OpenSSL dylibs.

## [1.5.0] - 2026-06-25

### Added
- 终端命令块导航：在多个 prompt / 命令块之间快速跳转、复制命令、复制输出、右键上下文操作
- 终端 Quick Select：扫描周围输出，按 token 一键复制（URL、路径、行号、commit hash 等）
- 终端文件链接：识别 `path:line` 形式的输出，按住修饰键点击直接在外部编辑器对应行打开，按所在行 cwd 解析相对路径
- 命令历史驱动的新会话：从最近用过的命令 / 目录直接预填新终端
- Command Palette 范围筛选：按 scope 过滤可执行项
- 终端进度序列：识别并显示 OSC 9;4 进度，让长任务在 tab / 状态条上有感
- 终端通知序列：识别终端发出的通知请求并桥接系统通知
- 终端粘贴防御：粘贴疑似不安全内容（含换行的命令等）前发出确认
- OSC 8 超链接：解析终端发出的 hyperlink，按统一策略走 opener
- ConEmu cwd OSC 支持，进一步覆盖 OSC 7 之外的终端工作目录上报
- OSC 52 写剪贴板：默认关闭，单独开关 `terminal_clipboard_write` 才生效
- 终端 ligature：作为 opt-in 选项，默认关闭
- 终端 dotfile 配置：通过项目 dotfile 配置终端行为
- Sticky command context：滚动时保持当前命令块顶部信息可见
- Aider agent 检测，agent 总数升至 12

### Changed
- 重新打磨终端命令 chrome
- 隔离 Codex 屏幕跟踪逻辑，避免污染其他 agent 的渲染路径
- 拆分终端视图模块，单文件不再无上限增长

### Fixed
- Agent hook 监听不可用时优雅降级，不再卡住启动流程
- Agent hook 文件保留在私有 runtime 目录，避免污染用户工作区
- 块复制只复制输出区，不复制命令本身；复制结果上报更准确
- 块导航 / 终端焦点的修饰键与系统约定对齐
- 终端字体加载延迟封顶，避免字体未到位时长时间空白
- Quick select 复制文本在重渲染期间保持不变
- 终端补全提示在某些场景下不再被错误折叠
- 修复修改配置后被覆盖的问题，保护用户编辑
- OSC 52 device attributes 路径加上 gate，避免 echo back 风险
- 重置外观时不再覆盖键位绑定
- 修剪未使用的 keyring 依赖与 UI 细节

### Security
- 完整审计 + 修复一批安全相关问题（详见 commit `e33ddd6 feat: comprehensive audit, security fixes, search UX, and Aider agent`）
- 明确 git 写操作边界并固化在 fixture

### Docs
- 仓库为开源做准备：README 重写、CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / THIRD_PARTY_NOTICES 就位
- 应用更名为 Tunara，文档与产物全面对齐
- CI 增加 macOS matrix + release 构建验证
- review 反馈整理为参考资料（不入源码仓库）

## [1.2.0] - 2026-06-21

### Added
- Session Recovery（Phase 1+2）：xterm buffer 快照 + 滚动位置恢复，跨重启保留终端内容
- 视觉语言升级：全面设计打磨

### Fixed
- 终端分栏切换时保持 pane 挂载，agent 进程不再因 tab 切换被销毁
- Homebrew cask 版本对齐到 1.2.0
- 快照恢复为空时也会结束启动流程，避免卡在 Splash
- 后台会话释放 WebGL renderer 并节流快照，降低多会话常驻内存
- 删除未纳入编译图的 secrets/shell 遗留模块，避免 CI 假绿

## [1.1.0] - 2026-06-21

### Added
- 侧栏键盘导航
- 密集列表滚动提示
- 右键菜单图标
- CLI 设置增强

### Changed
- UI 美学全面打磨：SessionCard 紧凑化、pill tab 统一、空状态重设计
- 侧栏/面板过渡动画
- Toast 通知升级（退出动画、hover 暂停、进度条）
- 交互动画（tab 切换淡入、diff 展开过渡、文件浏览滑入）
- Settings 主题预览简化
- 搜索图标组件化

### Removed
- 侧栏 footer（低价值）

## [1.0.2] - 2026-06-20

### Added
- 设置面板强调色派生色跟随 + 对比度修正 + 光标闪烁开关
- DiffPanel Staged/Unstaged 分区显示
- ⌘+/- 终端字号快捷调整
- ⌘1-9 快速切换会话

### Fixed
- 终端初始化乱码（fit.fit() 移到 WebGL addon 加载之后）
- 运行时健壮性修复（设置校验、响应式布局、文件预览截断、split 一致性）

## [1.0.1] - 2026-06-19

### Added
- Agent 生命周期 hook 系统 + 未读通知
- fish shell Agent 注入支持

### Fixed
- Codex 忙碌状态检测改用数据流驱动
- 搜索框 focus 光晕动画

## [1.0.0] - 2026-06-18

### Added
- 真实 PTY 多会话（portable-pty + xterm.js 6 + WebGL）
- 智能侧栏（按工作目录分组、折叠、拖拽排序、搜索过滤）
- 11 种 AI Agent CLI 自动检测 + 品牌标识
- 只读 Git Diff 审查面板（Staged/Unstaged/Untracked 分区）
- 文件浏览器 + 代码预览
- 水平/垂直分栏终端
- Command Palette（⌘K，权重排序）
- 7 套终端配色 + 深浅色模式
- 5 色强调色 + macOS 毛玻璃效果
- 一键跳转外部编辑器（VS Code / Cursor / Zed / Sublime）
- 会话 + UI 布局持久化
- 右键菜单（会话、目录组、文件）
- Toast 通知系统
- Agent 状态条（运行时长、改动计数）
- 终端搜索（⌘F）
- 窗口状态持久化
- 响应式布局
- macOS 自定义标题栏
- 自动更新（Tauri updater）
- CI/CD（GitHub Actions）

### Changed
- 从 terax 脚手架重构为独立产品
- 移除 Agent 管理平台方向，收口为纯终端 + 审查面板
- 移除 tailwind/shadcn/codemirror/ai-sdk 等未使用依赖
- 清理死代码约 11,700 行
