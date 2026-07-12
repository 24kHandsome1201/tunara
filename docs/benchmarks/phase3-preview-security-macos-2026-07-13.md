# Phase 3 安全 Preview WebView：macOS optimized 验收

## 结论

本批安全 WebView surface 与 navigation policy 已关闭，Phase 3 仍为进行中。真实 optimized macOS Tauri app 已证明：只有 active/resolved/local/eligible 来源能创建独立 Preview；页面虽能看到 Tauri 的低层 `__TAURI_INTERNALS__` 对象，但 app command 与 plugin command 均被 ACL 明确拒绝，`window.__TAURI__` 不存在；同源导航成立，跨 origin、popup 与 download fail closed。该结论不包含通用浏览器、SSH tunnel、截图、console/network、服务关联或 Phase 4。

## 隔离构建与 fixture

- 基线：`a7b898f9befb0e0e3780b04c15417e727fe371b7`，开始时等于 `origin/main`。
- 构建：复用 `/Volumes/2TB/codex-build-cache/rail/target` 的 release optimized target，没有清理 target 或改变 symlink。
- 为避免正式 `dev.tunara.app` single-instance 把验收启动转交给用户已有 Tunara，使用仅覆盖 product name/identifier 的 [`phase3-preview-tauri.conf.json`](../../scripts/fixtures/phase3-preview-tauri.conf.json) 生成 `Tunara Preview Security.app`。正式配置、用户已有窗口和 PTY 未被退出。
- 两个只监听 loopback 的受控 server：`127.0.0.1:41731` 与 `127.0.0.1:41732`，代码见 [`phase3-preview-security-server.mjs`](../../scripts/fixtures/phase3-preview-security-server.mjs)。主 checkout 与 detached linked worktree 分别输出两个 URL。

## 安全证据

41732 页面真实加载后显示 `{"internals":"object","globalApi":"undefined"}`。页面主动调用：

- `fs_read_file({path: "/etc/hosts"})` → `Command fs_read_file not allowed by ACL`
- `plugin:store|load(...)` → `Command plugin:store|load not allowed by ACL`

两次拒绝均由页面回传到本地 fixture JSONL，不是从 capability 文件推断；刷新与重开后拒绝重复成立。原始 JSONL、应用事件日志与验收截图仅在本机保留并由 `.gitignore` 排除，不进入 `main`。仓库只提交脱敏后的结构化结论汇总。

## Navigation / popup / download

- same-origin：41732 的 `/same-origin` 成功加载。
- 公网 redirect：请求到达 `/redirect-public` 并返回 `Location: https://example.com/...`，WKWebView top-level 仍为 fixture 根页。
- 跨端口：41732 页面请求 41731，top-level 保持 41732；当时 41731 JSONL 没有 `/peer` 请求。
- 外部协议：`tunara-preview-fixture://blocked` 后 top-level 保持 41732，没有系统接管。
- popup：页面记录 `popup-result {opened:false}`，没有新窗口。
- download：页面记录 click 与 `/download` 请求；Rust app 日志明确输出 `blocked Preview download: http://127.0.0.1:41732/download`，没有保存 sheet、页面变化或落盘。

## 来源、生命周期与隔离

主 checkout 使用独立 session/terminal 与 41731；linked worktree 使用另一组 session/terminal 与 41732。两个 Preview 同时存在，窗口标题各自完整显示 repository/worktree/session/terminal/URL；在窗口间切换仍分别显示正确 fixture，未共享状态。结构化汇总中的本机路径与运行时 session 标识已脱敏。

41732 使用原生红色关闭按钮销毁后，主窗口与 PTY 保留；再次点击同来源控制可重新创建页面，证明 `WindowEvent::Destroyed` 后没有残留注册阻挡。刷新实现经真实验收从单纯 `navigate` 收敛为 `reload + validated source navigate`：正常页面可刷新；fixture 停止时主窗口/PTY 仍在，fixture 恢复后刷新产生新的 `/` 请求并重新执行 ACL 探针。完成全部拒绝、原生关闭和页面失败路径后，主 checkout PTY 仍成功回显 `PHASE3_PTY_AFTER_PREVIEW_OK`；对应截图仅本地保留。

## 自动门禁

- `pnpm test`：Node 556/556；UI 10/10；Rust 173 passed、6 ignored（环境型既有门）。
- `cargo test ... preview::tests`：3/3。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm tauri build --bundles app --config scripts/fixtures/phase3-preview-tauri.conf.json`：optimized `.app` 成功。

结构化汇总见 [`evidence.json`](./raw/phase3-preview-security-2026-07-13/evidence.json)。

## 下一门

Phase 3 下一独立门是最小导航/页面失败提示与服务生命周期闭环。前进后退、地址栏、缩放、viewport、截图、console/network 摘要、服务重启关联、SSH tunnel 与 Phase 4 均未开始。
