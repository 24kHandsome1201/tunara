# M3 private payload 惰性富渲染 macOS 证据

日期：2026-07-15
源码基线：`e3e72eca66c9ecdc811fe271c730756d10faebc0` + 本切片未提交改动
机器：MacBook Air (Mac14,2)，Apple M2，16 GB，arm64
构建：optimized/release Tauri `.app`，真实 macOS WKWebView 与本机 PTY

## 边界

本切片复用现有 Agent Event Store 的 header/private payload 分离、typed IPC 和 Timeline 虚拟列表，只关闭 private payload 的惰性 Markdown、代码、diff、大型工具输出和本地图片渲染闭环。全文搜索、筛选索引与持久层轻量索引不在本批，Phase 4 整体继续保持部分完成。

界面继续采用现有安静、高密度、来源优先的终端工具方向，没有新增聊天壳、卡片墙、composer、CSS-in-JS、Tailwind、字体、图标或 radius 系统。富 renderer 是动态 chunk，最终 production gzip 2.89 kB，没有进入首屏静态关键路径。

本批及后续持续只使用 Mac 内置磁盘。worktree 位于 `~/.codex/worktrees`，`src-tauri/target` 链接到内置 `/private/tmp/rail-phase4-target`；未复制外置缓存、未执行 `cargo clean`。fixture、日志、截图与验收结果只存在于内置系统临时目录，完成后清理，未进入仓库。

## 安全与资源合同

- 只有 viewport 内或用户显式展开的事件才可发起单 event payload IPC。分页、task/workspace 切换和首次打开都只取 headers。
- 读取按 event + hash 去重，最多 4 个并发、16 个排队；显式展开可替换最旧的未开始 viewport 请求。缓存最多 24 条、6 MiB，scope 释放、row 回收和 consumer 取消会 abort 或丢弃 stale 结果。
- header 与 payload 的 event ID、声明 MIME、UTF-8 byte length、SHA-256、来源和 1 MiB 上限均再次验证。unknown provenance、缺失、损坏、迁移失败、类型或 hash 不匹配均 fail closed，只显示可解释占位，不影响 PTY。
- Markdown 不执行 HTML、script 或 MDX，远程链接和图片只显示标签。代码、文本、JSON 与 diff 最多读取 256 KiB、2,000 行，并最多产生 600 个富内容语义行。
- 图片只接受已支持的本地 PNG/JPEG/WebP payload，先检查 base64、magic、768 KiB 解码上限，再通过本地 `blob:` URL 解码并限制 4,096 像素单边及 12 MP。CSP 仅为本地图片加入 `blob:`；折叠、回收和卸载均 revoke object URL。

## 确定性规模门

fixture 固定生成 10,000 headers，其中包含 1,000 个 Markdown 代码块 payload、500 个工具输出、200 个 diff 和 100 张本地 PNG，共 1,800 个独立 0600 payload 文件。首屏没有富内容 DOM；当前 viewport 外 payload 不进入前端缓存，快速滚动时请求受并发、队列与 stale 丢弃约束。

release Rust harness 保持 header-only 性质：fixture 176 ms、重启 18 ms、最近页 36 µs、10,000 headers 全分页 2 ms、payload read 0、RSS 增量 8,800 KiB、fixture 3,326,628 bytes；真实 PTY 50 次回显 failure 0、p95 34 µs。

## optimized WKWebView 双轮结果

| 指标 | 第一次 | 第二次 | 结论 |
|---|---:|---:|---|
| 首次 Timeline 可用 | 144 ms | 145 ms | 通过 |
| 首屏 header / DOM rows | 100 / 9 | 100 / 9 | 有界 |
| 首屏 payload reads / cache | 6 / 6 条，552 B | 6 / 6 条，552 B | 只读真实 viewport，不预读全页 |
| 大型 diff / 工具 / Markdown DOM 行 | 600 / 600 / 599 | 600 / 600 / 599 | 预算生效 |
| 本地 PNG | 解码成功 | 解码成功 | MIME、magic、尺寸与 CSP 闭环通过 |
| 富内容缓存 | 24 条，76,882 B | 24 条，76,882 B | 低于 24 条 / 6 MiB 上限 |
| payload 并发峰值 | 4 | 4 | 通过 |
| 快速滚动 frame p50 / p95 / max | 17 / 18 / 21 ms | 17 / 18 / 19 ms | 通过 |
| 最终 / streaming DOM rows | 9 / 9 | 9 / 9 | 有界 |
| 进程 RSS | 125,808 KiB | 124,896 KiB | 记录项 |
| PTY 回显前 / 后 | 23 / 24 ms | 26 / 20 ms | 未受影响 |
| 重启恢复 | 不适用 | 100 headers 恢复 | 通过 |

分页锚点两轮均精确保持。显式展开先确认目标实际处于 viewport，动态高度通过现有 ResizeObserver 回报虚拟列表，并以该事件的 viewport offset 作为短生命周期测量锚点。快速滚动产生的 stale 结果不会串到回收后的 row；task 切换会销毁整个 payload scope。

## 像素与交互检查

optimized app 自动设置并检查 576×433、640×480、1200×800，Retina backing pixels 分别为 1152×866、1280×960、2400×1600，三档横向 overflow 均为 false。中英文标题、长任务名、长 worktree 路径和富内容都未遮挡真实终端。

Computer Use 读取了真实辅助功能树并确认终端输入仍是可聚焦的真实 PTY textarea；手工窗口截图检查了 1200×800 与紧凑窗口，Timeline 仍是现有 review panel，不是聊天壳。Enter 可展开或折叠选中 payload，Escape 折叠后可回到真实 PTY；后台/前台、task A/B 切换、应用完全退出后重启均在同一 optimized bundle 内通过。

## 门禁

- Node 全量：573 tests，570 passed、3 个既有 skip、0 failed。
- UI 定向回归：10 passed；UI 全量 29 passed；Rust 定向 13 passed、1 ignored；Rust 全量 206 passed、7 ignored、0 failed。
- 两套 TypeScript typecheck、ESLint、`cargo fmt --check`、strict clippy、frontend production build、optimized/release app、strict codesign 与 `git diff --check` 通过。
- capability 关闭、旧快照、unknown provenance、payload 删除/损坏/迁移失败、类型/大小/hash 不匹配均有 fail-closed 覆盖；不支持的 Agent 继续使用普通终端。

## 判定

Phase 4 / M3 private payload 惰性富渲染切片完成。全文搜索与持久层轻量索引仍是 Phase 4 的独立剩余门，本批不进入 Phase 5。
