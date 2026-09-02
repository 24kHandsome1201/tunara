# M1 Terminal + SSH 性能与乱码稳定性实施规格

## 唯一目标与用户价值

在不改变“真实终端 + 智能侧栏”产品边界的前提下，让本地和 SSH 终端在大输出、慢链路、大粘贴、频繁 resize 与断开场景中保持可输入、可关闭、无丢字和无乱码。M0 证据见 [已挂载终端基线](./benchmarks/m0-terminal-baseline-2026-07-11.md)。

## Scope

1. 补齐冷启动、首个 PTY 可输入、50/200MiB 混合输出、10+ session、bundle size 与 WebGL fallback 基线。
2. SSH 输入从消息数上限改为字节预算；大粘贴分块且提供明确 backpressure，不能静默丢失。
3. Close 使用独立取消路径，不排在 Data 后；Resize 使用 latest-value 合并，不积压历史尺寸。
4. SSH 输出采用 4-16ms 或 64-256KiB 的双阈值有界批处理，减少 IPC，同时保证尾包和退出前 flush。
5. 建立 100/200ms RTT 下连接、cwd、preview、grep、diff、取消、恢复与 SFTP 的真实 benchmark。
6. 建立 Unicode、ANSI、OSC、alternate-screen、IME、WebGL context loss 和 DOM fallback 的 reference capture。

## Non-scope

- 不实现 Markdown 编辑器、Preview、Timeline、Companion、Recipe 或新的远程写入 surface。
- 不把 Tunara 改成 agent 平台、聊天壳或 commit/push GUI。
- 不增加终端正文遥测，不持久化 SSH 密码、口令或 benchmark 内容。
- 不在本里程碑重做视觉系统；只修复性能导致的抖动、乱码和错误状态表达。

## Agent / TUI 兼容性补充门

Agent 和未知 TUI 的协议、输入、resize、状态与错误表达属于 M1，但仅用于证明终端正确性：本地与 SSH 不丢键、不破坏 alternate screen，不把 waiting / failed / disconnected 伪报为 running / completed，恢复时保持 transport、cwd、session identity 与原安全姿态。该门不要求为所有 Agent 配置外部 provider，不扩展为 Agent 管理平台，也不将凭据或组织策略阻断误记为 Tunara 缺陷。具体矩阵见 [M1 Agent / TUI 兼容性基线](./benchmarks/m1-agent-tui-compatibility-2026-07-11.md)。

## 依赖与复用

- 复用 `PtySession` 前端接口、russh 长连接、现有连接 phase 证据、PTY output buffer、WebGL atlas rebuild 和 TerminalView benchmark compile flag。
- 复用 M0 独立 bundle/fixture、真实 `de-netcup` SSH 主机和 `scripts/keep-mac-awake.sh`。
- 不改变已持久化 workspace/session schema；运行时队列状态不进入快照。

## 数据模型、接口与预计文件

- Rust 内部拆分 `Data`、`Close`、`Resize` 控制面：Data 使用 byte-budget permit；Close 使用 cancellation token/独立信号；Resize 保存单个最新值。
- 输出 batcher 只缓存有上限的 bytes 和首包时间，退出/EOF/error 必须 flush；前端仍接收现有 `PtyEvent::Data`。
- 公共 Tauri command 名称和前端 `PtySession` 形状默认保持兼容；只有无法表达 backpressure 时才增加显式错误码。
- 预计涉及 `src-tauri/src/modules/ssh/connection.rs`、SSH/PTY 测试、`pty-bridge.ts`、terminal output buffer/benchmark、脚本与报告，跨 Rust/TS/fixture 可能超过 8 个文件；每个可验证子批独立提交，不做一次性大重写。

## 行为与错误合同

- Happy path：按字节分块写入，输出按双阈值 flush，最终屏幕与 reference marker 一致。
- 大粘贴：调用方等待预算释放或收到可识别 backpressure；不得部分成功却返回成功。
- Close：输入队列已满、网络停顿或 output flood 时仍可取消，重复 Close 幂等。
- Resize：连续 resize 只发送最终尺寸；关闭后 resize 无害失败。
- 退出/断网：先 flush 已接收输出，再发唯一 Exit/Disconnected 证据；不会把网络断开伪装成 exit 0。
- 不支持的 shell/TUI/WebGL：显示 capability 与降级来源，不把启发式状态伪装成权威状态。

## 性能预算与验收

- 同机 12 session 普通输入 p95 不高于 M0 23ms 的 1.3 倍；同条件总增量 RSS 不高于 M0 406,656KiB 的 1.15 倍。
- SSH output batch 单包不超过 256KiB，首包等待不超过 16ms；50/200MiB fixture 无丢字、顺序错误或无界内存增长。
- 5 秒可见窗口 frame p95 不超过 33.4ms，至少 60 个样本；后台无 rAF 时 timeout flush 仍推进输出。
- Close 在本地可控测试中 250ms 内生效，不受满 Data 队列阻塞；Resize 最终值可观测一致。
- 100/200ms RTT 记录 p50/p95/max，不以单次快照替代；每次报告标明硬件、macOS、commit、fixture 和原始结果。
- 真实 macOS optimized bundle 跑本地 12 session、`de-netcup` SSH、窄窗/分屏、冷重启、中文路径和 30 分钟压力回归。

## 安全、隐私、开关与回滚

- byte budget、batch buffer 和 fixture 都有硬上限；日志只记录字节数、时长、phase 和错误分类。
- 继续沿用 known_hosts fail-closed、临时凭证内存单次消费、私有 runtime dir 和安全 remote bootstrap。
- benchmark 由 `VITE_TUNARA_BENCHMARK=m0` 编译期开关隔离；正常 bundle 必须继续证明无 benchmark 标记。
- 子批可通过回退内部实现恢复当前逐包/消息队列路径，不迁移用户数据；如出现丢输入、Close 卡死、屏幕与 reference 不一致或 RSS 无界增长，立即停止后续优化并回退该子批。

## 继续与完成条件

按顺序执行：固定剩余 baseline -> 输入/控制面 -> 输出 batching -> 慢链路与高输出 -> WebGL/乱码矩阵。所有预算、真实 bundle 和回归门禁通过后才结束 M1；未通过时不启动 M2。
