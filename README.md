# Conduit

AI 原生终端 —— 基于 Tauri + xterm.js 的桌面应用。

不是"带侧边栏的普通终端":侧边栏是按工作目录分组的会话列表，每个会话挂一个 AI agent（Claude Code / Codex / Cursor）；主区是真实终端流，AI 回复内联渲染并带「应用补丁 / 查看 diff」操作；右栏是跟随当前会话的 diff / 审查面板，可直接 commit & push。

> 当前阶段：Tauri + React 工程已搭建，真实 PTY、多会话 UI、Agent harness、Git diff/commit/push、设置页与更新配置正在迭代中。

## 开发命令

```bash
pnpm install
pnpm build
pnpm test
pnpm tauri dev
```

- 前端构建：`pnpm build`（TypeScript + Vite）
- Rust 单测：`pnpm test`（等价于 `cargo test --manifest-path src-tauri/Cargo.toml`）
- Tauri dev/build 配置也使用 pnpm，避免与 lockfile 版本漂移。

## 目录结构

```
.
├── .github/workflows/          # CI / Release workflow
├── docs/                       # 调研、实施与验收文档
│   ├── 调研-Conduit终端方案.md       # 设计稿研究 + 终端核心可复用性调研
│   ├── 调研-三大难点深入.md
│   └── 实施文档-从零到完整功能.md
├── src/                        # React 前端（主窗口、设置页、终端、Git/Agent bridge）
├── src-tauri/                  # Tauri/Rust 后端（PTY、Agent harness、Git、文件系统）
└── _unzipped_design/           # 设计交付包（已解压）
    └── design_handoff_conduit_terminal/
        ├── README.md           # 设计交接文档（唯一规范来源：tokens/布局/交互/状态）
        ├── Conduit.dc.html     # 高保真可交互原型（主参考）
        └── Terminal Concepts.dc.html  # 风格探索看板（结论：Paper 浅色为最终方向）
```

> ⚠️ 设计稿 HTML 使用内部 DSL，仅描述外观与交互，**不是生产代码**。需用目标框架按像素复刻视觉壳层，终端区接入真实 xterm.js。

## 技术方向

- **外壳（UI）**：按设计稿用前端框架重写（React / Svelte / Vanilla TS）。
- **终端核心**：不从零造，以 Apache-2.0 的 `terax-ai-tauri-terminal` 为蓝本（已实现多 PTY 并发、背压、shell 集成、文件树）。
- **工程范围**：真实终端 + 会话编排 + AI 集成 + Git 集成。

## 当前能力边界

- Prompt 式新建 Agent 当前支持 Claude Code（CC）和 Codex（CX）；其他 Agent 仅在真实终端里做命令识别与展示标记，尚未接入后端 harness。
- Git 提交只提交审查面板列出的文件路径，不做全仓 `git add -A`。
- CI 会在 push/PR 上执行前端 build 和 Rust 单测；release workflow 只负责打包发布。

详见 [`docs/`](docs/)。
