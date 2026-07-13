# Phase 3 Preview 页面失败与服务生命周期：macOS optimized 验收

## 结论

当前最小页面失败提示与手动服务生命周期 Active Milestone 已关闭；Phase 3 因 GOAL required gates 仍有明确后置项而继续进行中。真实 optimized macOS 隔离应用已覆盖 ready、初始不可达、运行中服务停止/恢复、terminal exit stale、双 linked worktree 状态隔离与原生关闭/重开。失败状态不再伪装 ready，PTY 与 main window 在 Preview 失败后保持可用。

## 状态与恢复合同

- Rust runtime entry 的来源 label 覆盖 repository、worktree、workspace、session、terminal generation 与 source URL；另有单调 window generation。page-load、timeout 与 Destroyed 只在 label + generation 同时匹配时更新，旧窗口不能污染同来源重开。
- Inspector 显示 `opening / loading / ready / unreachable-failed / closed / source stale-terminal exited`。页面失败提供 Refresh、Close 与外部浏览器逃生口；terminal exit 后禁止 Focus、Refresh 与新建内置 Preview，但仍允许 Close 和外部打开。
- Open/Refresh 只对已通过 active/resolved/local/eligible 校验的精确 loopback source host + effective port 做 350ms TCP connect；不发送 HTTP、不扫描端口、不访问公网，不启动、重启或终止用户服务。
- Refresh 每次只有一个动作：ready 页面 reload，failed 页面 validated navigate。前端状态轮询单飞且带 request sequence，迟到响应不能覆盖新状态。

## optimized macOS 实机矩阵

隔离 product/identifier 的 release optimized `.app` 复用既有外置 target cache 构建；没有接管用户已有 Tunara。

| 场景 | 结果 |
|---|---|
| 正常打开 | 精确 loopback fixture 加载，Inspector 显示 ready |
| 初始不可达 | 原生 Preview window 可关闭，Inspector 立即显示 unreachable/failed 与恢复说明，不显示 ready |
| 运行中服务停止 | 用户点击 Refresh 后当前来源 fail closed；main window 与终端继续可输入，受控 PTY marker 在同屏可见 |
| 服务恢复 | 只在用户再次点击 Refresh 后进入 loading 并回到 ready；没有自动重启或后台轮询服务 |
| terminal exit | 来源保留为 stale/terminal-exited；Focus/Refresh 被禁用，Close 与外部浏览器仍可用 |
| 两个 worktree/端口 | 主 checkout 来源停止并 failed 时，detached linked worktree 的另一端口仍为 ready；窗口标题与 Inspector 来源身份各自独立 |
| 原生关闭/重开 | 红色关闭按钮后状态回 closed；同来源重开重新 ready，没有旧 Destroyed/timeout 残留 |

## 安全回归

上一批精确 origin navigation、跨端口/公网 redirect/外部协议拒绝、popup/download 拒绝与 Preview 空权限 capability 未改变。最终 linked-worktree fixture 再次加载并主动执行 app/plugin invoke 探针，结果继续为 capability ACL 拒绝；页面没有获得主窗口权限。

原始 fixture JSONL、应用事件日志与验收截图只保留本机并受 `.gitignore` 保护。仓库提交的结构化汇总已去除本机绝对路径、真实运行时 session/terminal 标识与个人信息。

## 自动门禁

- 完整 Node：556/556；Preview UI 组件所在 UI 矩阵：12/12。
- 完整 Rust：175 passed、6 个环境型既有门 ignored；Preview 定向用例覆盖精确 origin、来源隔离、stale close 边界与精确 loopback listener。
- TypeScript typecheck、lint、`cargo clippy --all-targets -- -D warnings`、production frontend build 与最终 optimized Tauri `.app` 构建通过。

## Phase 3 状态

本批只关闭最小页面失败提示与手动服务生命周期。前进后退、地址导航、缩放、viewport、截图、console/network 摘要、服务重启关联和 SSH tunnel 仍是未满足的 Phase 3 required gates；Phase 3 保持进行中，不进入 Phase 4。
