# 文档归档

这里存放里程碑规格、评审记录、手工验收清单和阶段性证据。它们回答“当时做了什么”，不再作为当前产品合同。现行说明见 [docs/README.md](../README.md)。

## 里程碑与评审

| 文件 | 历史背景 |
|------|----------|
| [GOAL_STATUS.md](./GOAL_STATUS.md) | Goal 拆成可验证增量后的交付证据矩阵；M0–Phase 3 关闭账本 |
| [M1_TERMINAL_SSH_PERFORMANCE.md](./M1_TERMINAL_SSH_PERFORMANCE.md) | M1 终端 + SSH 性能与乱码稳定性的实施规格 |
| [M2_MARKDOWN_SAFE_EDITING.md](./M2_MARKDOWN_SAFE_EDITING.md) | M2 Markdown 阅读与单文件安全轻编辑的实施规格 |
| [PHASE3_PREVIEW_SOURCE_CONTRACT.md](./PHASE3_PREVIEW_SOURCE_CONTRACT.md) | Phase 3 Workspace-bound Preview 的来源绑定、WebView 与导航合同 |
| [PRODUCT_REVIEW.md](./PRODUCT_REVIEW.md) | 2026-08-18 对照 2.0.1 源码的全量功能盘点与成本/价值取舍 |
| [TERMINAL_COMPETITIVE_GAPS.md](./TERMINAL_COMPETITIVE_GAPS.md) | 2026-08-16 对照 iTerm2 / Ghostty / Warp 等的缺口调研，含明确不抄项 |
| [THEME_SHELL_TINTING.md](./THEME_SHELL_TINTING.md) | 当时把界面主题与终端 palette 收成互斥选择器的配色规范 |
| [MIGRATION.md](./MIGRATION.md) | Conduit → Tunara 产品改名后的一次性状态迁移说明 |
| [VISUAL_QA.md](./VISUAL_QA.md) | macOS release bundle 原生窗口 chrome 的手工视觉验收清单 |
| [ACCESSIBILITY_MANUAL_QA.md](./ACCESSIBILITY_MANUAL_QA.md) | 钉在特定 commit 上的无障碍手工 QA 矩阵（键盘、读屏、SSH 流程） |

## 阶段性证据（`benchmarks/`）

`benchmarks/` 是各阶段真实验收报告与脱敏原始证据，不是产品说明。

| 文件 | 历史背景 |
|------|----------|
| [runtime-baselines.md](./benchmarks/runtime-baselines.md) | Runtime counter 快照约定与可复跑 scale 矩阵说明 |
| [m0-terminal-baseline-2026-07-11.md](./benchmarks/m0-terminal-baseline-2026-07-11.md) | M0：12 个已挂载终端的冷启动 / RSS / 输入延迟基线 |
| [m1-terminal-startup-2026-07-11.md](./benchmarks/m1-terminal-startup-2026-07-11.md) | M1：冷启动与首 PTY 可输入 5-run 基线 |
| [m1-terminal-high-output-2026-07-11.md](./benchmarks/m1-terminal-high-output-2026-07-11.md) | M1：本地 50/200 MiB 高输出与 WebGL fallback |
| [m1-terminal-stress-2026-07-11.md](./benchmarks/m1-terminal-stress-2026-07-11.md) | M1：38 分钟 / 16 GiB 终端压力回归 |
| [m1-ssh-control-2026-07-11.md](./benchmarks/m1-ssh-control-2026-07-11.md) | M1：SSH 输入字节预算、Close/Resize 控制面与输出批处理 |
| [m1-ssh-high-output-2026-07-11.md](./benchmarks/m1-ssh-high-output-2026-07-11.md) | M1：真实主机 50/200 MiB SSH 高输出 |
| [m1-ssh-rtt-harness-2026-07-11.md](./benchmarks/m1-ssh-rtt-harness-2026-07-11.md) | M1：100/200ms RTT 下 cwd/preview/grep/diff/SFTP/取消 |
| [m1-ssh-recovery-2026-07-11.md](./benchmarks/m1-ssh-recovery-2026-07-11.md) | M1：SSH 断线唯一 exit 与原位恢复 cwd |
| [m1-agent-tui-compatibility-2026-07-11.md](./benchmarks/m1-agent-tui-compatibility-2026-07-11.md) | M1：本地/SSH Agent 与未知 TUI 兼容矩阵 |
| [m1-closure-audit-2026-07-12.md](./benchmarks/m1-closure-audit-2026-07-12.md) | M1 关闭审计：规格对照与不阻塞 Phase 2 的环境附录 |
| [m2-local-safe-write-linux-2026-07-12.md](./benchmarks/m2-local-safe-write-linux-2026-07-12.md) | M2：Linux/ext4 本地安全写完整性 |
| [m2-ssh-safe-write-2026-07-12.md](./benchmarks/m2-ssh-safe-write-2026-07-12.md) | M2：SSH 安全写、断线对账与 GUI 闭环 |
| [phase2-editor-visual-2026-07-12.md](./benchmarks/phase2-editor-visual-2026-07-12.md) | Phase 2：编辑器窄窗视觉与键盘验收 |
| [m2-local-safe-write-macos-2026-07-13.md](./benchmarks/m2-local-safe-write-macos-2026-07-13.md) | M2：macOS 本地保存、冲突与草稿生命周期 |
| [m2-native-close-macos-2026-07-13.md](./benchmarks/m2-native-close-macos-2026-07-13.md) | M2：macOS 原生关闭按钮的 dirty 草稿门 |
| [m2-terminal-startup-macos-2026-07-13.md](./benchmarks/m2-terminal-startup-macos-2026-07-13.md) | M2：macOS 首 PTY 冷启动硬门，据此关闭 Phase 2 |
| [phase3-preview-security-macos-2026-07-13.md](./benchmarks/phase3-preview-security-macos-2026-07-13.md) | Phase 3：Preview WebView ACL 与 navigation policy |
| [phase3-preview-lifecycle-macos-2026-07-13.md](./benchmarks/phase3-preview-lifecycle-macos-2026-07-13.md) | Phase 3：页面失败状态与手动服务生命周期 |
| [phase3-preview-navigation-macos-2026-07-13.md](./benchmarks/phase3-preview-navigation-macos-2026-07-13.md) | Phase 3：同源地址与原生 Back/Forward 历史 |
| [phase3-preview-restart-macos-2026-07-13.md](./benchmarks/phase3-preview-restart-macos-2026-07-13.md) | Phase 3：来源关联与 fail-closed 重启准备 |
| [phase3-preview-zoom-viewport-macos-2026-07-13.md](./benchmarks/phase3-preview-zoom-viewport-macos-2026-07-13.md) | Phase 3：有限原生缩放与常用 viewport |
| [phase3-preview-telemetry-macos-2026-07-13.md](./benchmarks/phase3-preview-telemetry-macos-2026-07-13.md) | Phase 3：失败摘要采集与绑定 PTY 送回 |
| [phase3-preview-ssh-tunnel-macos-2026-07-13.md](./benchmarks/phase3-preview-ssh-tunnel-macos-2026-07-13.md) | Phase 3：SSH remote loopback 显式 tunnel |
| [phase3-preview-capture-macos-2026-07-13.md](./benchmarks/phase3-preview-capture-macos-2026-07-13.md) | Phase 3：Preview 截图与安全送回，据此关闭 Phase 3 |

`benchmarks/raw/` 是对应报告的脱敏 JSON / CSV / 截图；本机日志与未脱敏截图仍由 `.gitignore` 排除。
