# Tunara 文档

这里只放描述**现在是什么**的文档。产品原则和“明确不做”以 [GOAL.md](./GOAL.md) 为准；当前代码对照以 [FEATURES.md](./FEATURES.md) 为准。贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

| 文档 | 读它能知道什么 |
|------|----------------|
| [GOAL.md](./GOAL.md) | 产品目标、原则、已交付范围、平台支持和明确不做的边界 |
| [FEATURES.md](./FEATURES.md) | 当前用户可见能力对应到前端/后端代码入口 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | React 与 Tauri 后端如何拼在一起：IPC、三种传输、托管 state、启动顺序 |
| [STATE_AND_PERSISTENCE.md](./STATE_AND_PERSISTENCE.md) | Zustand store 划分、工作区快照、恢复边界和 sanitizer |
| [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) | 纸面视觉主张：色彩、字体、圆角、布局与交互约定 |
| [DEFAULT_TERMINAL_PALETTE.md](./DEFAULT_TERMINAL_PALETTE.md) | 默认 Light/Dark 终端调色板与外壳 token 的对应关系 |
| [AGENT_DETECTION.md](./AGENT_DETECTION.md) | Agent 如何被检测、生命周期如何跟踪，以及新增一个 agent 要改哪里 |
| [INSPECTOR_PANELS.md](./INSPECTOR_PANELS.md) | 检查器交互模型：自动选择、锁定、各视图职责 |
| [SIDEBAR_SSH.md](./SIDEBAR_SSH.md) | 左侧栏如何按本机目录 / SSH 主机分组会话 |
| [TERMINAL_INTERACTIONS.md](./TERMINAL_INTERACTIONS.md) | 右键、复制、安全粘贴与终端快捷键的触发边界 |
| [TERMINAL_SELECTION_COPY.md](./TERMINAL_SELECTION_COPY.md) | 选区复制 / 粘贴（⌘C、右键）的产品合同 |
| [LIMITED_LARGE_FILE_VIEWING.md](./LIMITED_LARGE_FILE_VIEWING.md) | 大文本/日志的前 N / 后 N 行受限查看合同与 IPC 限额 |
| [TESTING.md](./TESTING.md) | Node / UI / Cargo 三套测试怎么跑、怎么加 |
| [DEPENDENCY_ADVISORIES.md](./DEPENDENCY_ADVISORIES.md) | 已接受的依赖安全残留风险与 bump 政策 |
| [ROADMAP.md](./ROADMAP.md) | 已落地能力叙事与后续建议 |

版本变更见 [CHANGELOG.md](../CHANGELOG.md)。

## 归档

里程碑规格、评审记录、手工验收清单和阶段性证据已移到 [archive/](./archive/)。归档标准：描述“当时做了什么 / 当时怎么验收”的记录进 archive；描述“现在是什么”的合同留在本目录。
