# Changelog

All notable changes to Conduit are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
