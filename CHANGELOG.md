# Changelog

All notable changes to Tunara are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
- 完整审计 + 修复一批安全相关问题（详见 commit `e3322dd feat: comprehensive audit, security fixes, search UX, and Aider agent`）
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
