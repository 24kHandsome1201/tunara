# Contributing

欢迎参与贡献。Issue、PR 和想法都欢迎。

## 快速开始

```bash
pnpm install
pnpm tauri dev
```

前置条件：Rust stable、Node 20+、pnpm 9+、以及平台对应的 [Tauri 依赖](https://tauri.app/start/prerequisites/)。

## 提交 PR 前

```bash
pnpm typecheck                                  # 前端类型检查
pnpm build                                      # 前端构建
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm test                                        # 全部测试
```

如果改动了 `src-tauri/`，至少构建一次 release：

```bash
pnpm tauri build
```

## 分支

从 `main` 创建分支，使用以下前缀（kebab-case）：

| 前缀 | 用途 |
|------|------|
| `feat/` | 新功能 |
| `fix/` | Bug 修复 |
| `chore/` | 重构、工具、配置、依赖 |
| `docs/` | 仅文档变更 |
| `perf/` | 性能优化 |

示例：`feat/command-blocks`、`fix/pty-leak`、`chore/bump-tauri`。

## 非小改动请先开 Issue

超出 typo、小 bug 修复或 `good-first-issue` 范围的改动，请先开 Issue 讨论方案。10 分钟讨论胜过 500 行不符合路线图的 PR。

## 欢迎的贡献

- **Bug 修复**：随时欢迎
- **新功能**：非小改动请先开 Issue
- **文档 / typo / 小 UX 修复**：直接提 PR
- **新 Agent 识别**：参考 `src/modules/agent/registry-data.json` 和 `src/modules/agent/registry.ts`
- **终端配色方案**：参考 `src/styles/terminalTheme.ts`

## 不接受的贡献

- 内置 AI 聊天、模型接入、MCP 编排或云 agent 能力
- Agent catalog / 启动器 / 批量启动入口
- DiffPanel 里的 stage、commit、push 等 Git 写操作
- 遥测、分析或任何回传数据的功能
- 硬编码 API 密钥或账户
- 为小功能引入大依赖（保持轻量）
- 无功能变更的大规模重构

## 代码风格

- 遵循现有模式，修改前先阅读相邻文件
- TypeScript：避免 `any`
- Rust：`cargo fmt` + `clippy` clean
- 少写注释，只解释 why 而非 what
- 内联样式 + CSS 自定义属性（tokens.css），不使用 CSS Modules

## Commits & PR

Squash-merge，PR 标题遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(terminal): add command blocks
fix(pty): prevent session leak on close
chore(deps): bump xterm to 6.x
```

类型：`feat`、`fix`、`chore`、`docs`、`perf`、`refactor`、`test`、`build`、`ci`。
常用 scope：`terminal`、`sidebar`、`diff`、`pty`、`agent`、`settings`、`palette`、`ui`。

一个 PR 一个逻辑变更。UI 变更请附截图/GIF。

## 项目结构

```
src/                    # React 前端
├── app/                # 应用入口、初始化、快捷键、主题
├── modules/
│   ├── terminal/       # xterm.js 会话、OSC handler、agent 生命周期
│   ├── fs/             # 文件系统桥接
│   ├── git/            # Git 桥接
│   ├── agent/          # Agent 注册表
│   ├── ssh/            # SSH 主机 profile / 凭证桥接 / SFTP 桥接
│   └── editor/         # 外部编辑器跳转
├── state/              # Zustand store（sessions + ui + persist）
├── styles/             # CSS tokens + 终端主题
└── ui/                 # UI 组件

src-tauri/src/          # Rust 后端
├── modules/
│   ├── pty/            # PTY 会话管理（portable-pty）
│   ├── git/            # Git 操作（git2）
│   ├── fs/             # 文件系统（目录树、搜索、grep）
│   ├── agent/          # Agent CLI 预检 + hooks
│   ├── ssh/            # SSH 客户端（russh、SFTP、host profile、known_hosts TOFU）
│   ├── editor/         # 编辑器启动
│   ├── resolver/       # 二进制路径解析
│   └── process/        # 子进程管理
└── lib.rs              # Tauri 命令注册
```

## 安全问题

安全漏洞请不要公开提 Issue，发送邮件至维护者。

## 许可证

贡献的代码遵循 [LICENSE](LICENSE) 中的许可协议。
