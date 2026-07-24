# Phase 3 Preview 来源关联与安全重启准备：macOS optimized 验收

## 结论

服务失效关联与 fail-closed 重启准备门禁已关闭。optimized macOS 隔离应用在两个 linked worktree、两个不同 loopback 服务与两条真实 physical PTY 上证明：A 失效时只关联 A 的完整来源与已证明命令，准备动作只填入 A 且不执行；用户显式提交后 A 恢复，B 全程保持独立。Phase 3 仍因截图与 SSH tunnel 未完成而继续进行中，不进入 Phase 4。

## 安全合同

- 来源键覆盖 repository、worktree、workspace、session、terminal generation、source URL 与 physical PTY；Inspector 明确展示并可回到来源终端。
- 只信任同一 PTY 的 OSC 133 显式提交记录。Rust runtime 重新核对 generation、sequence、timestamp、命令指纹、完整来源与当前 PTY；不从页面、URL、端口、进程或任意历史命令推断。
- 只接受最长 384 bytes 的窄服务启动单命令。CR/LF、控制字符、超长输入、compound/subshell、重定向、pipe、引号/转义/通配与危险命令均拒绝。
- prepare 只写经过复核的命令字节，不附加回车，不执行；PTY 忙碌、stale、退出、旧 generation、跨来源/端口、provenance 改变、重复 prepare 与状态竞争均 fail closed。
- 状态仅在 runtime；新 generation 再次输出 URL 后替换旧 provenance，旧 failure/eligibility 不污染关闭重开或另一来源。

## optimized macOS 实机矩阵

| 场景 | 结果 |
|---|---|
| 双来源基线 | 两个 linked worktree、两个不同端口、两条 physical PTY 均 resolved 且 Preview ready |
| A 失效 | 停止 A 并 Refresh 后 A failed/eligible；B 仍 ready |
| 完整来源与跳转 | Inspector 显示完整来源键；“查看来源终端”回到并聚焦 A 的真实 xterm |
| 只填不执行 | 重启动作只让 A 输入区增加原命令；B snapshot 不变；服务未自动启动 |
| 显式恢复 | 用户显式提交后 A 产生新 generation 并回到 ready；关闭重开仍 ready、无旧 failure |
| fail-closed | 跨来源、旧 generation、不可信后续命令、terminal exit 全部拒绝并保持不可执行 |
| 页面权限 | 文件、store、PTY、app command 0 次意外成功；Preview capability 未扩大 |

验收使用应用自身 benchmark、真实 WebView/PTY 状态与 loopback listener，不使用 Accessibility。最终脱敏汇总的所有布尔门均为 true，`privilegeUnexpectedSuccesses=0`；原始终端尾部、应用日志、fixture、隔离 bundle 与临时 worktree 已清理，未进入 Git。

## 自动门禁

- Node 561 项：558 passed、3 个既有 skipped；UI 17/17。
- Rust 196 项：190 passed、6 个既有环境型 ignored。
- 两套 TypeScript typecheck、lint、`cargo fmt --check`、严格 clippy（all targets/features、warnings as errors）、production build 与 optimized Tauri app build 通过。
- 自动用例覆盖 ready→停止/端口失效→failed→恢复、完整来源/physical PTY、双 worktree/端口隔离、旧 generation/关闭重开/stale/PTY exit/忙碌/不可信命令、只填不执行、危险 shell payload、Preview ACL、旧 snapshot 降级与原始 artifact 不跟踪。

## Phase 3 状态

本批只关闭服务失效关联与安全重启准备。截图和 SSH tunnel 仍是 required gates；Phase 3 保持进行中，不进入 Phase 4。
