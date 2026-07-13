# Phase 3 Preview 同源地址与原生历史：macOS optimized 验收

## 结论

可信 main Inspector 的同源地址导航与 Back/Forward Active Milestone 已关闭；Phase 3 因缩放/viewport、截图、console/network、服务重启关联与 SSH tunnel 仍未完成而继续进行中。真实 optimized macOS 隔离应用证明历史按钮状态来自当前 WKWebView 的原生 back-forward list，两个 worktree/端口及关闭重开的窗口不会共享历史。

## 安全与状态合同

- 地址输入只存在于可信 main 控制面；Preview 页面仍无 app/plugin capability。
- Rust 以当前 Preview URL 解析相对 path/query/fragment 或完整 URL，再严格匹配来源 scheme、host 与 effective port。凭据、跨 scheme/host/port、公网、外部协议、空值和非法 URL fail closed。
- `preview_status` 从当前 macOS WKWebView 读取真实 URL、`canGoBack` 与 `canGoForward`；Back/Forward 执行前再次读取原生历史，不接受前端索引。
- 完整来源键与 window generation 继续隔离 runtime 状态；原生关闭销毁历史，重开从批准来源 URL 建立新窗口。

## optimized macOS 实机矩阵

隔离 product/identifier 的 release optimized `.app` 复用既有外置 target cache 构建，没有清理 target 或接管正式 Tunara。

| 场景 | 结果 |
|---|---|
| A → B → Back → Forward | 从来源根页导航到同源 path；B 时 Back enabled，Back 后 Forward enabled，Forward 后回到 B |
| 可信地址输入 | 相对 path 成功规范化并加载；当前 URL 由真实 Preview window 回传 |
| 非法/跨 origin | 跨端口 loopback 与公网完整 URL 均在 Rust boundary 明确拒绝，当前页和历史不变 |
| 两个 worktree/端口 | 一端位于 B 且 Back enabled 时，另一端仍位于来源根页且 Back/Forward disabled |
| 服务停止/恢复 | 服务停止后手动 Refresh 进入 failed；恢复后仅再次手动 Refresh 回 ready |
| 原生关闭/重开 | 带历史窗口用红色关闭按钮销毁后状态回 closed；重开从来源根页开始，Back/Forward disabled |
| PTY/main | Preview failed、恢复、跨 origin 拒绝与原生关闭期间主窗口保持，真实 PTY 继续接受 marker 输入 |

页面主动 ACL 探针继续得到 app/plugin capability 拒绝；既有集中 navigation policy 对 redirect、popup 与 download 的拒绝未改变。原始 fixture JSONL、应用事件日志和截图只保留在 `.gitignore` 覆盖的本机目录；提交内容不含本机用户名、绝对路径或真实 session/terminal 标识。

## 自动门禁

- Node：556/556；Preview UI 所在组件矩阵：13/13。
- Rust：177 passed、6 个既有环境型门 ignored；Preview 定向 7/7。
- TypeScript typecheck、UI typecheck、lint、`cargo fmt --check`、严格 clippy、production frontend build 与 optimized macOS `.app` 构建通过。

脱敏结构化汇总见 [`evidence.json`](./raw/phase3-preview-navigation-2026-07-13/evidence.json)。

## Phase 3 状态

本批只关闭同源地址导航与前进/后退历史。缩放/viewport、截图、console/network 摘要、服务自动启动/重启关联与 SSH tunnel 仍是未满足的 Phase 3 required gates；Phase 3 保持进行中，不进入 Phase 4。
