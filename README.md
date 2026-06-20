# Conduit

AI 原生终端，基于 Tauri + xterm.js 的桌面应用。

Conduit 当前的产品边界是：**带智能侧栏的真实终端**。真实 xterm / PTY 是主角；侧栏按工作目录组织会话，展示运行状态、Agent CLI 识别和上下文；右栏是跟随当前会话目录的只读 diff / 文件审查面板。它不是 Agent 管理平台、聊天工具、MCP 编排器、低配 IDE 或 Git GUI。

> 当前阶段：Tauri + React 工程已搭建，真实 PTY、多会话 UI、终端内 Agent CLI 识别、只读 Git diff / 文件审查、设置页、命令面板和窗口状态正在迭代中。

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
├── docs/                       # 调研、实施、产品判断与验收文档
│   ├── 调研-Conduit终端方案.md       # 设计稿研究 + 终端核心可复用性调研
│   ├── 调研-三大难点深入.md
│   ├── 实施文档-从零到完整功能.md
│   ├── 测试文档-界面与功能Review.md
│   ├── 产品评估-竞品分析与演进方向.md
│   └── 产品规划-功能增删与设计优化.md
├── src/                        # React 前端（主窗口、设置页、终端、Git/Agent 状态）
├── src-tauri/                  # Tauri/Rust 后端（PTY、Git、文件系统、CLI 解析）
└── _unzipped_design/           # 设计交付包（已解压）
    └── design_handoff_conduit_terminal/
        ├── README.md           # 设计交接文档（唯一规范来源：tokens/布局/交互/状态）
        ├── Conduit.dc.html     # 高保真可交互原型（主参考）
        └── Terminal Concepts.dc.html  # 风格探索看板（结论：Paper 浅色为最终方向）
```

> ⚠️ 设计稿 HTML 使用内部 DSL，仅描述外观与交互，**不是生产代码**。需用目标框架按像素复刻视觉壳层，终端区接入真实 xterm.js。

## 技术方向

- **外壳（UI）**：React + Zustand + 设计 token，复刻 Paper/light + Terracotta + JetBrains Mono 的桌面终端方向。
- **终端核心**：Tauri v2 + `portable-pty` + xterm.js/webgl。PTY、背压和 shell integration 参考 Apache-2.0 的 `terax-ai-tauri-terminal`，并保留第三方说明。
- **工程范围**：真实终端、多会话编排、终端内 Agent CLI 识别、只读 Git diff / 文件审查、设置与命令面板。

## 当前能力边界

- 当前主流程不提供独立“新建 Agent”弹层。用户在真实终端里启动 `claude` / `codex` / `amp` 等 CLI 后，Conduit 只做识别、品牌标记、运行状态和 review 辅助。
- 右侧审查面板是只读 review 面板，不提供 commit / push GUI。用户可以在终端中使用 `git`，也可以让外部 agent 自己处理提交。
- CI 会在 push/PR 上执行前端 build 和 Rust 单测；release workflow 只负责打包发布。

详见 [`docs/`](docs/)。
