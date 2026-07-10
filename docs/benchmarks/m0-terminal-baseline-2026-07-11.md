# M0 已挂载终端性能基线（2026-07-11）

状态：**通过，作为 M0 Phase 1 完成证据。**

## 环境

| 项目 | 值 |
|---|---|
| Hardware | Apple M2 |
| macOS | 26.1（25B5072a） |
| Tunara commit | `719f6777f8902d32cca8551a6825a12106d93f49` |
| Build | optimized release benchmark bundle |
| Bundle identifier | `dev.tunara.m0benchmark` |
| Fixture | 12 个本地 session，目录为本仓库，12 个 TerminalView 与真实 PTY 均已挂载 |
| 命令 | `scripts/benchmark-m0-terminals.sh all`；干净 commit 复测使用 `scripts/benchmark-m0-terminals.sh run` |

benchmark bundle 使用独立 identifier 和 Application Support，不读写正式 Tunara 会话。只有 `VITE_TUNARA_BENCHMARK=m0` 构建包含采样接线；正常 production build 已验证不含 `benchmark:m0`、`m0-mounted-terminals` 或该环境变量标记。

## 方法

- 输入延迟：12 个终端同时写入唯一 shell marker，从前端调用 `pty.write` 到 marker 从对应 PTY 输出流返回，使用 `performance.now()` 计时。
- 帧时间：输入探针并行期间连续采样 5 秒 `requestAnimationFrame`，至少 60 帧才接受。
- App/PTY RSS：每 250ms 从进程表采样主进程及其 PTY 子进程。
- Renderer RSS：WKWebView 可能复用预热 WebKit XPC 进程，因此先记录系统 WebKit RSS baseline，再对 GPU、Networking、WebContent 的正增量求和。
- 总增量 RSS：每个采样点的 App RSS + Renderer RSS delta + PTY RSS，报告峰值与均值。
- 先前锁屏和 `CUALockScreenGuardian` 完全遮挡窗口产生的 0-frame 结果均被判为无效，没有进入本报告。

## 结果

| 指标 | 结果 |
|---|---:|
| 已请求 / ready 终端 | 12 / 12 |
| 输入回显 p50 / p95 / max | 20 / 23 / 23 ms |
| 帧样本数 | 301 |
| 帧时间 p50 / p95 / max | 17 / 19 / 23 ms |
| App RSS peak | 110,672 KiB |
| Renderer RSS delta peak | 257,264 KiB |
| PTY RSS peak | 56,784 KiB |
| Total incremental RSS peak / mean | 406,656 / 349,821.20 KiB |
| App + PTY CPU mean | 5.31% |
| Bundle size | 14,284 KiB |
| Probe failures | 0 |

接受条件全部满足：ready terminal 不少于 10、输入 p95 有限、frame sample 不少于 60、frame p95 有限、renderer delta 可测且 probe 无失败。

## 原始证据与隐私

- [result.json](./raw/m0-terminal-baseline-2026-07-11/result.json)
- [process-samples.csv](./raw/m0-terminal-baseline-2026-07-11/process-samples.csv)
- 可复跑入口：[benchmark-m0-terminals.sh](../../scripts/benchmark-m0-terminals.sh)

采样只记录时长、帧间隔、资源数值和失败原因，不记录终端正文，不上传遥测。
