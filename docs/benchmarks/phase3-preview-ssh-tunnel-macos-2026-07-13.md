# Phase 3 SSH remote loopback Preview tunnel：macOS optimized 验收

## 结论

SSH remote loopback required gate 已关闭。隔离 identifier 的 optimized macOS Tauri 应用通过真实 codex-netcup transport、两条独立 SSH session/physical PTY 与两个 Git workspace，完成用户显式、来源绑定、fail-closed 的 remote loopback → 本机派生 Preview 闭环。Phase 3 仍因截图门未完成而继续进行中，不进入 Phase 4。

## 产品与安全边界

- 远端 URL 先保持 `remote-manual`；只有可信 main 的显式动作和新 256-bit nonce 能建立 tunnel。
- Rust 前后两次核对 repository/worktree/workspace/session/terminal generation/physical PTY、SSH host/port/user、remote URL 与同一存活 session。
- transport 仅复用既有 authenticated russh handle 的精确 loopback `direct-tcpip`；本地只绑定 OS 分配的 `127.0.0.1` 端口。没有 shell 拼接、端口扫描、任意代理、reverse/dynamic/SOCKS、凭据复制或远端配置修改。
- 原始 remote source identity 与派生 local endpoint 同时可见且只驻留内存；Preview 页面 capability 仍只有 telemetry ingest。

## optimized macOS 实机矩阵

| 门 | 结果 |
|---|---|
| 两个真实 SSH Git workspace/session/physical PTY | 通过；来源 identity 与 physical generation 均不同 |
| 同一 remote port 的 IPv4 / IPv6 loopback 服务 | 通过；A/B 获得不同 OS 分配本地端点，两个真实 WKWebView 分别完成页面 ACL telemetry |
| 单侧停服 | 通过；A 原生 Refresh 后 tunnel/Preview failed，B 保持 ready |
| 显式关闭与重建 | 通过；B 关闭后 runtime/listener 消失，只有新 nonce 的新显式动作可恢复 |
| terminal / SSH exit | 通过；对应 listener/runtime 回收，旧来源重建拒绝 |
| 竞争与旧动作 | 通过；并发建立仅一个 winner，nonce replay、跨 worktree、stale、旧 physical generation 全部拒绝 |
| Preview 页面 ACL | file/store/PTY/SSH/tunnel/app 六类主动探针意外成功 0 次 |

应用自身最终结构化结果为 16 个布尔门全部 true、`aclUnexpectedSuccesses=0`、`passed=true`。原始应用日志、终端输出、远端 fixture 实例与 bundle 未进入 Git；仓库只保留可审阅的验收夹具源码。

## 自动回归与构建门

- Node、UI 与 Rust 全量测试通过；Rust 为 190 passed、6 个显式环境依赖项 ignored。
- 两套 TypeScript typecheck、lint、`cargo fmt --check`、all-targets/all-features 严格 clippy、production frontend build 与隔离 identifier optimized Tauri app build 通过。
- tunnel 定向测试覆盖 IPv4/IPv6 loopback/effective port、凭据与公网 URL、非法端口、nonce 形状、派生来源 identity；UI/ACL 回归覆盖显式动作、derived endpoint 与 Preview capability 无 tunnel/SSH 高权限。

## 清理

验收结束后隔离应用、远端临时 Git workspace/fixture/服务、SSH/tunnel 子任务与本地 listener 均清理；共享 Rust target 未清理或破坏。Git 仅保留代码、测试、规格与本脱敏报告。
