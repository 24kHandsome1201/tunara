# Tunara 文档

按读者角色分入口。产品原则和“明确不做”以 [GOAL.md](./GOAL.md) 为准；当前代码对照以 [FEATURES.md](./FEATURES.md) 为准。

## 先看哪一份

| 文档 | 用途 |
|------|------|
| [FEATURES.md](./FEATURES.md) | 功能与代码地图：用户可见能力对应到前端/后端入口 |
| [PRODUCT_REVIEW.md](./PRODUCT_REVIEW.md) | 全量功能盘点：成本/价值取舍与主路径缺口 |
| [GOAL.md](./GOAL.md) | 产品目标、平台支持、Agent 边界 |
| [ROADMAP.md](./ROADMAP.md) | 已落地能力与后续建议 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 前后端 IPC、三种传输、托管 state、启动顺序 |
| [STATE_AND_PERSISTENCE.md](./STATE_AND_PERSISTENCE.md) | Zustand store、工作区快照、恢复边界 |
| [TESTING.md](./TESTING.md) | Node / UI / Cargo 三套测试怎么跑、怎么加 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献流程与欢迎/不接受的改动 |

## 功能专题

| 文档 | 用途 |
|------|------|
| [AGENT_DETECTION.md](./AGENT_DETECTION.md) | Agent 识别、生命周期、新增 agent 清单 |
| [TERMINAL_INTERACTIONS.md](./TERMINAL_INTERACTIONS.md) | 右键、复制、安全粘贴与终端快捷键边界 |
| [TERMINAL_SELECTION_COPY.md](./TERMINAL_SELECTION_COPY.md) | 选区复制行为 |
| [TERMINAL_COMPETITIVE_GAPS.md](./TERMINAL_COMPETITIVE_GAPS.md) | 与 iTerm2 / Ghostty / Warp / cmux 等对比后仍缺、以及明确不抄的项 |
| [M2_MARKDOWN_SAFE_EDITING.md](./M2_MARKDOWN_SAFE_EDITING.md) | Markdown / 单文件安全写合同 |
| [LIMITED_LARGE_FILE_VIEWING.md](./LIMITED_LARGE_FILE_VIEWING.md) | 大文本前 N 行受限查看 |
| [PHASE3_PREVIEW_SOURCE_CONTRACT.md](./PHASE3_PREVIEW_SOURCE_CONTRACT.md) | Preview 来源绑定与安全边界 |
| [THEME_SHELL_TINTING.md](./THEME_SHELL_TINTING.md) | 界面与终端统一配色 |
| [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) | 视觉与交互约定 |
| [INSPECTOR_PANELS.md](./INSPECTOR_PANELS.md) | 检查器交互模型：自动选择、锁定与视图清单 |
| [SIDEBAR_SSH.md](./SIDEBAR_SSH.md) | 左侧栏 SSH 按主机分组：已落地合同、落地前根因与后续体验项 |
| [TITLEBAR_DEVICE_TABS.md](./TITLEBAR_DEVICE_TABS.md) | 标题栏按当前设备收口工作面：已落地合同与示意图 |

## 发布、验收与历史

| 文档 | 用途 |
|------|------|
| [GOAL_STATUS.md](./GOAL_STATUS.md) | Goal 交付证据矩阵 |
| [VISUAL_QA.md](./VISUAL_QA.md) | macOS 原生窗口视觉验收 |
| [ACCESSIBILITY_MANUAL_QA.md](./ACCESSIBILITY_MANUAL_QA.md) | 无障碍手工验收 |
| [M1_TERMINAL_SSH_PERFORMANCE.md](./M1_TERMINAL_SSH_PERFORMANCE.md) | 终端 / SSH 性能门 |
| [MIGRATION.md](./MIGRATION.md) | Conduit → Tunara 迁移 |
| [DEPENDENCY_ADVISORIES.md](./DEPENDENCY_ADVISORIES.md) | 已知依赖安全公告 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |

`docs/benchmarks/` 是各阶段真实验收报告与原始证据，不是产品说明。
