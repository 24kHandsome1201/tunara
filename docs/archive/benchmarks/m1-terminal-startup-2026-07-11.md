# M1 冷启动与首 PTY 基线（2026-07-11）

## 结论

当前 optimized macOS benchmark bundle 连续执行 5 次独立进程启动，每次都重新创建 12 个真实 PTY。5 次均达到 12/12 ready、输入探针 0 failure、frame p95 18ms。

首轮从进程启动到窗口可见 560ms，到首个 PTY 可输入 1,772ms，到全部 12 个 PTY 可输入 1,778ms。5-run 中位数分别为 502ms、1,639ms、1,639ms。

输入 p95 中位数 27ms，低于 M0 23ms × 1.3 的 29.9ms 预算；总增量 RSS peak 中位数 413,088 KiB，低于 M0 406,656 KiB × 1.15 的 467,654 KiB 预算。bundle 为 14,300 KiB。

## 环境与复跑

| 项目 | 值 |
|---|---|
| 硬件 | Apple M2, arm64 |
| 系统 | macOS 26.1 (25B5072a) |
| commit | `2d06004677bac67ba8375006db2441467b69a352` |
| 构建 | optimized release M0 benchmark bundle |
| fixture | 12 个本地 session / TerminalView / PTY |
| 命令 | `scripts/benchmark-m0-terminals.sh series` |
| series | 5 次，奇数样本中位数门禁 |

脚本在启动 app 前记录 wall-clock epoch；System Events 只读观察目标 PID 的 `visible + window count`，不激活窗口。WebView 用 `performance.timeOrigin + performance.now()` 记录 app ready、全部 writer ready、首个与全部输入 marker 返回。series 要求所有结果属于同一 commit，且所有轮次 ready 数、failure 数和 frame 门都通过。

原始摘要见 [result-summary.json](./raw/m1-terminal-startup-2026-07-11/result-summary.json)。

## 5-run 结果

| 指标 | 首轮 | 中位数 | 最差 | 预算 |
|---|---:|---:|---:|---:|
| 窗口可见 | 560ms | 502ms | 560ms | 记录值 |
| 首 PTY 可输入 | 1,772ms | 1,639ms | 1,772ms | 记录值 |
| 全部 12 PTY 可输入 | 1,778ms | 1,639ms | 1,778ms | 记录值 |
| 输入 p95 | 26ms | 27ms | 30ms | 中位数 ≤ 29.9ms |
| frame p95 | 18ms | 18ms | 18ms | 每轮 ≤ 33.4ms |
| 总增量 RSS peak | 408,352 KiB | 413,088 KiB | 416,816 KiB | 中位数 ≤ 467,654 KiB |
| bundle | 14,300 KiB | 14,300 KiB | 14,300 KiB | 记录值 |

5 次窗口可见为 477-560ms，首 PTY 可输入为 1,600-1,772ms，输入 p95 为 26-30ms。最差输入 p95 30ms 比预算高 0.1ms，但验收合同使用 5-run 中位数以抑制单次调度抖动；所有轮次均无输入失败，frame p95 全部为 18ms。

## 边界

- 这是 app 进程完全退出后的重新启动，不等同于重启 macOS 后的磁盘冷缓存或首次 Gatekeeper 校验。
- SSH 冷连接由高 RTT 与恢复报告单独覆盖，不与本地 12 PTY 启动值混为同一指标。
