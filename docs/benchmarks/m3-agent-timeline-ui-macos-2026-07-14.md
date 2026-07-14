# M3 Agent Timeline macOS UI、虚拟列表与 PTY 隔离证据

日期：2026-07-14
源码基线：`c4f7f60133697eca4d02e4e685130625fd32f9b8` + 本切片未提交改动
机器：MacBook Air (Mac14,2)，Apple M2 8-core，16 GB，arm64
构建：Tauri release optimized 隔离 `.app`，真实 WKWebView 与本机 PTY

## 目标与边界

本报告只证明 Phase 4 / M3 的 Timeline 核心切片：从既有 Rust Agent Event Store 分页读取轻量 header、动态高度虚拟列表、分页锚点、底部跟随/上滚不抢、流式事件合并、task 切换、来源可信度与回到真实 PTY。它不包含 private payload 的 Markdown/code/diff/图片渲染、搜索持久层、Agent 启动/协调、PTY 自动写入、Mobile Companion 或 Journal，因此不把 Phase 4 整体标为完成。

确定性 fixture 在 app-local-data 隔离目录生成 10,000 headers；原始 JSON、应用日志、完整命令输出和截图只留在系统临时目录并在验收后删除，未进入仓库。

## optimized 双重启结果

| 指标 | 第一次 | 第二次 | 结论 |
|---|---:|---:|---|
| 首次 Timeline 可用 | 72 ms | 107 ms | 通过 |
| 首屏前端保留 header | 100 | 100 | 未全量载入 |
| 首屏 / streaming / 最终 DOM rows | 12 / 12 / 12 | 12 / 12 / 12 | DOM 有界 |
| 向上分页事件锚点 | 精确保持 | 精确保持 | 通过 |
| 锚点像素补偿 | 6,704 px | 6,704 px | 动态高度后稳定 |
| 快速滚动 frame p50 / p95 / max | 17 / 19 / 19 ms | 17 / 19 / 19 ms | 通过 |
| streaming append | 不抢位置，完成后固化 | 不抢位置，完成后固化 | 通过 |
| task B 保留 header | 100 | 100 | task 隔离通过 |
| 后台回前台 | 28 ms | 35 ms | 通过 |
| PTY 输入回显前 / 后 | 13 / 18 ms | 20 / 22 ms | 未受影响 |
| 进程 RSS | 128,864 KiB | 125,360 KiB | 记录项 |
| private payload 可见/读取 | 否 / 0 | 否 / 0 | 通过 |

release Rust 专用 harness 在同一共享 optimized target 上再次确认：fixture 193 ms、重启 open 24 ms、最近页 48 µs、10,000 headers 全分页 3 ms、payload read 0、RSS 增量 8,384 KiB、fixture 3,326,628 bytes、真实 PTY p95 13 µs、failure 0。

## 行为与像素检查

- capability/feature flag 关闭、旧快照和缺失字段均安全降级；关闭时不读取 Event Store，PTY 照常挂载和输入。
- 分页以实际渲染事件及其 viewport 像素偏移为锚点；新行测量期间持续复用同一锚点，并禁用浏览器自身 scroll anchoring，避免两套校正竞争。
- live header 通过 animation frame 合并，只给当前 streaming row 短暂状态；历史 row 对象保持稳定。上滚时只增加未读，只有位于底部时自动跟随。
- 来源无法绑定到当前 workspace 的真实 session 时显示 `unknown` 并禁用跳转；已证明来源可在两步内聚焦绑定 PTY，不发送、不填入、更不执行命令。
- 真实 Retina 窗口逐张检查 576×433、640×480、1200×800；自动化记录的 backing pixels 分别为 1152×866、1280×960、2400×1600，三者横向 overflow 均为 false。窄窗下 Inspector 完整、终端仍可见，长 repository/worktree/session、中英文 summary 与来源字段使用现有截断策略，无遮挡。
- 中文和英文界面、快速滚动、Older 分页、streaming append、task 切换、后台/前台及第二次完全重启恢复均在真实 optimized app 内执行。Computer Use 与本机截图尝试仅用于人工像素观察，截图未提交。

## 门禁

- Node 全量：573 tests，570 passed、3 个既有 sandbox skip、0 failed；UI 全量与 Timeline 定向测试通过。
- Rust 全量：205 passed、7 ignored、0 failed；typed IPC、capability 关闭、旧数据恢复和 release 10,000-header harness 通过。
- 两套 TypeScript typecheck、ESLint、`cargo fmt --check`、strict clippy、production frontend build、optimized macOS app bundle、`git diff --check` 均通过。
- production chunk 未新增依赖；Timeline 沿用现有 CSS/tokens/font/icon/radius，主 App chunk 541.70 kB（gzip 149.48 kB）。

## 判定

M3 Timeline 核心 UI、10,000-header 有界前端闭环、动态高度分页锚点、streaming/task/unread 语义、键盘/中英文/窄窗、真实 PTY 隔离与 optimized macOS 像素门完成。Phase 4 仍保留 private payload 富渲染、搜索等后续独立切片，整体状态保持“部分完成”。
