# Phase 3 Preview 基础失败摘要与绑定 PTY 送回：macOS optimized 验收

## 结论

基础 console error、unhandled error 与 network failure 摘要门禁已关闭。隔离 identifier 的 optimized macOS 应用在两个 linked worktree、两个 loopback fixture 与两条真实 PTY 上完成来源隔离、脱敏、清空、关闭重开和显式 Send；Send 只填入绑定 PTY 且未执行。Phase 3 因截图、服务重启关联与 SSH tunnel 尚未完成而继续进行中。

## 安全与数据合同

- 不可信 Preview capability 只有 nonce/generation/source-bound 的 `preview_telemetry_ingest`；main 使用独立显式命令白名单。fixture 对文件、store、PTY 写入均得到 ACL 拒绝，伪造 ingest nonce 也被拒绝。
- 只接受三种严格 JSON schema 和 allowlist network method/phase/status；拒绝未知字段、超长字段、任意对象和不支持类别。
- URL 去凭据、query、fragment；同源只保留脱敏 path，外部 origin 不展开。secret marker、用户名、绝对路径与长高熵 token 不进入摘要。
- 单 generation 32 条 bounded ring、相同事件去重计数、页面每秒 12 条与 Rust 每 10 秒 40 条双层限额；状态只在 runtime。
- Send 在 Rust 侧生成单行摘要并再次核对完整来源键、window generation 与 `physicalPtyId`，不附加回车。

## optimized macOS 实机矩阵

| 场景 | 结果 |
|---|---|
| 双来源采集 | A/B 各自收到 `console-error`、`unhandled-error`、`network-failure`；HTTP 503 只显示安全 method/path/status/phase |
| Inspector | 可信 main Preview tab 显示 A 的 bounded summary；凭据、query、fragment、fixture secret 与绝对路径均不可见 |
| PTY Send | A/B 摘要分别只进入绑定物理 PTY 输入区；另一 PTY不受影响，未出现 shell 执行结果；随后以 Ctrl+U 清空输入 |
| Clear | 当前来源 telemetry events 清零，dropped counter 重置 |
| 关闭重开 | A 重开后 window generation 增加；新摘要无 B 端口或旧 generation 污染 |
| 页面权限 | `fs_read_file`、store、`pty_write` 全部 ACL 拒绝；伪造 nonce 的 ingest 被来源/generation 校验拒绝；0 次意外成功 |
| 主窗口与终端 | 两条真实 PTY 正常打开；Preview 采集、清空、关闭重开不影响 main 或另一 PTY |

验收不使用 Accessibility 自动化。应用自身 benchmark 只输出上述脱敏布尔值、类别列表和端口角色；原始 fixture JSONL、应用日志、完整命令输出与 bundle 只留本机 temp/ignored 路径，不进入 Git。

## 自动门禁

- Rust 单元覆盖三类失败、严格 schema/大小/速率/条数、URL/秘密脱敏、bounded ring/去重、跨来源/跨端口/旧 generation，以及 Send 单行不执行合同。
- Node/UI 覆盖 Preview capability 无高权限桥、Inspector summary、脱敏 URL、Copy/Send/Clear 与来源物理 PTY绑定。
- 全量 Node 558（555 passed、3 个既有 skipped）、UI 15/15、Rust 191（185 passed、6 个既有环境型 ignored）通过。
- 两套 TypeScript typecheck、lint、`cargo fmt --check`、严格 clippy（all targets/features、warnings as errors）与 production build 通过。

## Phase 3 状态

本批只关闭基础 console/network 摘要与绑定 PTY 送回。截图、服务自动启动/重启关联与 SSH tunnel 仍是 required gates；Phase 3 保持进行中，不进入 Phase 4。
