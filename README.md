# Conduit

> 轻量好看的 AI 原生侧栏终端 — Tauri + React + xterm.js

Conduit 是一个带智能侧栏的真实桌面终端。真实 xterm / PTY 是主角，侧栏按工作目录组织会话并展示运行状态和 Agent CLI 识别，右栏提供只读 Git diff 审查面板。它不是 Agent 管理平台、聊天工具、IDE 或 Git GUI。

## 特性

### 终端核心
- 真实 PTY 多会话（portable-pty + xterm.js 6 + WebGL 渲染）
- 水平/垂直分栏（⌘D / ⌘⇧D）
- 终端内搜索（⌘F）+ 匹配计数
- 命令块输出筛选（文本 / 正则 / 大小写 / 反选 / 上下文行）
- 可点击 URL 链接
- 可配置 scrollback（1,000 – 20,000 行）
- RAF 合批输出节流，16ms flush + 1MiB PTY 背压 + 2MiB 前端输出背压
- OSC 7 工作目录追踪 + OSC 133 Shell Integration

### 智能侧栏
- 会话按工作目录自动分组
- 目录组折叠/展开
- 拖拽排序、搜索过滤（fuzzy match）、重命名
- Unread 指示器 + 运行状态
- 关闭确认（running 状态双击确认）
- 目录级批量关闭

### AI Agent 识别
- 自动检测 12 种 Agent CLI：Claude Code、Codex、Amp、Gemini、Copilot、Cursor、Droid、OpenCode、Pi、Auggie、Devin、Aider
- 品牌标识角标 + 运行状态条（starting / idle / running）
- Agent Hooks 监听（结构化生命周期事件）
- Agent 改动计数

### 审查面板
- 只读 Git Diff（Staged / Unstaged / Untracked 分区）
- 文件浏览器 + 代码预览（语法高亮 + Markdown）
- 一键跳转外部编辑器（VS Code / Cursor / Zed / Sublime）
- 二进制/超大文件降级提示
- Ahead/Behind 远程状态

### 桌面体验
- 7 套终端配色（default / catppuccin / tokyo-night / one-dark / solarized / github-light / rose-pine-dawn）
- 深浅色模式 + 跟随系统
- 5 色强调色
- macOS 毛玻璃效果 + 自定义标题栏
- Command Palette（⌘K，权重排序）
- 会话 + UI 布局跨重启恢复
- 窗口状态持久化（位置、尺寸）
- 响应式布局（窄窗自动隐藏侧栏/右栏）
- Toast 通知（退出动画、hover 暂停、进度条）
- 右键菜单（会话、目录组、文件）

## 安装

### 从 Release 下载

前往 [Releases](https://github.com/24kHandsome1201/conduit/releases) 下载最新版本。

### 从源码构建

```bash
pnpm install
pnpm tauri build
```

前置条件：Rust stable、Node 20+、pnpm、以及平台对应的 [Tauri 依赖](https://tauri.app/start/prerequisites/)。

## 开发

```bash
pnpm install          # 安装依赖
pnpm tauri dev        # 启动开发模式
pnpm build            # 前端构建
pnpm typecheck        # 类型检查
pnpm test             # 运行全部测试（Node.js + Rust）
```

## 快捷键

| 操作 | macOS | Windows/Linux |
|------|-------|---------------|
| 新建终端 | ⌘T | Ctrl+T |
| 关闭会话 | ⌘W | Ctrl+W |
| 水平分栏 | ⌘D | Ctrl+D |
| 垂直分栏 | ⌘⇧D | Ctrl+Shift+D |
| 切换分栏焦点 | ⌘] / ⌘[ | Ctrl+] / Ctrl+[ |
| Command Palette | ⌘K | Ctrl+K |
| 终端搜索 | ⌘F | Ctrl+F |
| 设置 | ⌘, | Ctrl+, |
| 切换侧栏 | ⌘\\ | Ctrl+\\ |

## 技术栈

- **前端**：React 19 + Zustand 5 + xterm.js 6 + WebGL + Vite 7
- **后端**：Tauri v2 + Rust（git2、portable-pty、tokio）
- **字体**：Inter Variable + JetBrains Mono

## 目录结构

```
src/                    # React 前端
├── app/                # 应用入口、初始化、快捷键、主题
├── modules/            # 终端、Git、文件系统、Agent、编辑器桥接
├── state/              # Zustand 状态管理（sessions + ui + persist）
├── styles/             # CSS tokens + 终端主题
└── ui/                 # UI 组件（Sidebar、MainArea、DiffPanel 等）

src-tauri/src/          # Rust 后端
├── modules/
│   ├── pty/            # PTY 会话管理（portable-pty）
│   ├── git/            # Git 操作（git2，只读）
│   ├── fs/             # 文件系统（目录树、搜索、grep）
│   ├── agent/          # Agent CLI 预检 + hooks 监听
│   ├── editor/         # 外部编辑器跳转
│   ├── resolver/       # 二进制路径解析
│   └── process/        # 统一子进程管理
└── lib.rs              # Tauri 命令注册
```

## 许可证

[LICENSE](LICENSE)
