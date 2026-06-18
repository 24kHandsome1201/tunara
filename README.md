# Conduit

AI 原生终端 —— 基于 Tauri + xterm.js 的桌面应用。

不是"带侧边栏的普通终端":侧边栏是按工作目录分组的会话列表，每个会话挂一个 AI agent（Claude Code / Codex / Cursor）；主区是真实终端流，AI 回复内联渲染并带「应用补丁 / 查看 diff」操作；右栏是跟随当前会话的 diff / 审查面板，可直接 commit & push。

> 当前阶段：设计与调研完成，工程脚手架尚未搭建。

## 目录结构

```
.
├── docs/                       # 调研与实施文档
│   ├── 调研-Conduit终端方案.md       # 设计稿研究 + 终端核心可复用性调研
│   ├── 调研-三大难点深入.md
│   └── 实施文档-从零到完整功能.md
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

详见 [`docs/`](docs/)。
