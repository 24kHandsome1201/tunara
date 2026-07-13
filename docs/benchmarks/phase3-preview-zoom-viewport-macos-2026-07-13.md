# Phase 3 Preview 缩放与常用 viewport：macOS optimized 验收

## 结论

可信 main Inspector 的有限原生缩放与常用 viewport Active Milestone 已关闭。隔离 identifier 的 optimized macOS 应用以受控 loopback fixture 的页面 `innerWidth/innerHeight`、WKWebView 原生 zoom 回读和窗口 inner/outer 回读交叉验证；Phase 3 因截图、console/network 摘要、服务重启关联和 SSH tunnel 尚未完成而继续进行中。

## 控制与状态合同

- 页面无新增 bridge/capability；zoom/viewport 命令只从可信 main 调用并只定位完整来源键对应的 `preview-*` 窗口。
- zoom 只接受 75/90/100/110/125/150%，拒绝 NaN、无限值、越界与非预设；成功返回前读取 `WKWebView.pageZoom` 核对。
- viewport 只接受 390×844、768×1024、1280×720，另有 Fit 与 980×720 Reset。macOS 以 `WKWebView.frame - safeAreaInsets` 作为 CSS 内容尺寸，并异步等待 resize 提交；requested、CSS 内容尺寸、outer 和 exact 分开报告，不能命中时明确 unavailable。
- 状态 runtime-only，并受 window generation 保护；不进入 workspace snapshot。关闭重开恢复 100% 与默认 viewport。

## optimized macOS 实机矩阵

| 场景 | 结果 |
|---|---|
| Zoom presets / Reset | 六个预设均由 WKWebView 原生值回读；视觉比例随值变化，Reset 回 100% |
| Viewport presets | fixture 页面依次报告 390×844、768×1024、1280×720；Inspector 同步回报相同 CSS 内容尺寸，native outer size 单独记录 |
| Fit / Reset | Fit 使用当前 monitor 的受控预算并由 fixture 报告 1630×960；Reset 回 980×720 |
| 屏幕约束 | native inner 未命中 requested 时动作明确失败并展示 actual，不静默标记 exact |
| 双 worktree | main/43131 保持 100% 与 980×720，detached worktree/43132 可独立切换 zoom，并在 Reset zoom 后保持 390×844；两端 ACL 探针均拒绝，不跨来源键串用 |
| 原生关闭重开 | runtime entry 销毁；重开回 100%/980×720，旧 generation 不回写 |
| main / PTY | main window 全程 800×600；两个 PTY 均以 55×27 打开，Preview resize/zoom 未产生 PTY resize 记录 |
| lifecycle / security | 停服/恢复、地址、Back/Forward、Refresh/Close/外部浏览器、navigation/popup/download/ACL 拒绝保持 |

原始 fixture JSONL、应用日志、完整命令输出和截图只保留在 `.gitignore` 覆盖的本机目录；本文不含用户名、绝对路径、真实 session id 或个人信息。

## 自动门禁

- Node 556/556；UI 14/14；Rust 179 passed、6 个既有环境型门 ignored；Preview Rust 定向 9/9。
- 两套 TypeScript typecheck、lint、`cargo fmt --check`、严格 clippy、production frontend build 与 optimized macOS 隔离应用构建通过。

## Phase 3 状态

本批只关闭缩放与常用 viewport。截图、console/network 摘要、服务自动启动/重启关联与 SSH tunnel 仍是 required gates；Phase 3 保持进行中，不进入 Phase 4。
