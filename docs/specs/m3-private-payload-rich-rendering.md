# M3 private payload 惰性富渲染短规格

## 目标与方向

本切片只关闭 Phase 4 / M3 private payload 的惰性富渲染闭环。Timeline 继续是安静、高密度、来源优先的终端工具：header 用于定向，富内容是原事件行内的可选证据。不得增加聊天壳、卡片墙、composer、平台风格迁移或第二套 CSS、图标、字体、圆角系统。

全文搜索、筛选索引和持久层轻量索引明确不在本切片，留给下一独立切片。Agent 启动/协调、PTY 自动写入/执行、Mobile Companion、Task Journal 与 Phase 5+ 同样不在范围内。

## 数据与加载合同

- 复用 Event Store 的 `AgentEventHeaderV1` / private payload 分离与 typed IPC。列表、分页、task/workspace 切换和首次打开只读取 header，不调用 payload command。
- 只有 payload 行真实进入 viewport，或用户在该行明确展开时，才允许读取对应 event payload。虚拟列表 overscan 行不得触发读取。
- 前端资源管理器按 event ID 去重，使用 `AbortSignal` 取消消费者，限制并发和单位时间请求，按字节与条目双预算维护 LRU。row 回收、task/workspace generation 变化、能力关闭和组件卸载都释放消费者并丢弃 stale 结果。
- Tauri 文件读取本身可能已进入不可中断的短 I/O；取消后结果不得进入 React state、解析队列或缓存。切换 scope 时清空该 scope 的缓存与指标，避免 private payload 跨 task/workspace 留在前端内存。
- viewport 只允许读取和验证。Markdown 解析、代码高亮、diff 解析和图片解码只在用户明确展开后动态 import/执行，不进入首屏静态模块图。

## 验证与 fail-closed

- 读取结果必须逐项匹配 header 的 event ID、content type、UTF-8 byte length 与 SHA-256；header 和返回值均只接受 allowlist MIME。来源为 `unknown`，来源 session 无法绑定到当前 workspace，或 metadata 不完整时不读取正文。
- 支持 `text/plain`、`text/markdown`、`application/json`、`text/x-diff` 与本地 `image/png`、`image/jpeg`、`image/webp`。Markdown 不执行 HTML/MDX/JS，不创建远程链接或远程资源；所有内容通过 React text nodes 输出。
- 图片 body 为严格 base64，禁止 data/http/file URL。解码后只生成本地 Blob object URL；限制编码字节、解码字节、MIME、宽高和总像素。折叠、row 回收、scope 切换和卸载必须 revoke URL。
- 缺失、删除、损坏、hash/size/type 不匹配、旧 schema、迁移失败和不支持 MIME 均显示稳定、可解释的本地占位，不透传后端路径或正文，不影响真实 PTY。

## 渲染预算与交互

- 所有 private payload 默认折叠。大型文本、代码和 diff 永不自动展开；展开时最多保留 256 KiB、2,000 行，DOM 最多 600 个富内容行/块，超出部分显示明确截断说明。
- JSON 只做 bounded `JSON.parse` 和格式化，失败时按纯文本受限显示。Markdown parser 沿用现有安全 reader；代码采用无 `innerHTML` 的最小 token renderer；diff 沿用现有行分类语义并受同一 DOM 预算。
- 展开/折叠和图片固有尺寸就绪会触发现有 `ResizeObserver` 测量。虚拟列表以当前事件和 viewport pixel offset 恢复锚点；上滚不抢位置，底部跟随保持原语义。
- Timeline listbox 中 Enter 展开/折叠选中且有 payload 的事件；Escape 先折叠，已折叠时回到真实 PTY。行内按钮可键盘操作，长路径和中英文必须在 576×433、640×480、1200×800 下不横向溢出。

## 验收与停止条件

- 持续使用 Mac 内置磁盘：worktree 留在 `~/.codex/worktrees`，Cargo target 使用内置盘 `/private/tmp/rail-phase4-target`，fixture、日志、截图、录屏和临时证据只写内置盘 ignored/cache/temp。不得依赖或写入任何 `/Volumes/*` 外置路径，不复制旧外置缓存、不 `cargo clean`、不破坏任一缓存。
- 确定性测试证明 10,000 headers 为零 eager payload read，并覆盖 1,000 Markdown 代码块、500 工具调用、200 diff、100 本地图片的按需读取、解析、缓存与请求风暴预算；viewport 外 payload 不进入前端内存，快速滚动不产生 stale 串行。
- 必跑定向 React/Node/Rust、Node/Rust 全量、两套 typecheck、lint、`cargo fmt --check`、严格 clippy、production build、optimized/release macOS Tauri、`git diff --check`，以及 capability/旧快照/损坏 payload/10,000 headers/真实 PTY 隔离门。
- 真实 WKWebView 验收覆盖首次打开、快速滚动、大型代码/diff/图片展开、task 切换、后台/前台和重启恢复，记录 frame、DOM、RSS、payload read/cache 与 PTY 输入输出影响。原始 fixture、日志、截图、录屏、图片和完整命令输出只写 ignored/cache/temp。
- 若权限或锁屏成为唯一 GUI 阻塞，保留隔离 worktree并精确报告，不提交、不推送、不伪造。全部门通过后只做一个提交并推送 `origin/main`；Phase 4 仍保持部分完成，剩余门只有全文搜索/持久层轻量索引。
