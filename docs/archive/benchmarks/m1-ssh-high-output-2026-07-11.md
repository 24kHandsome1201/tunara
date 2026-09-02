# M1 SSH 50/200 MiB 高输出基线（2026-07-11）

## 结论

真实 optimized macOS bundle 通过 `de-netcup` 上两条独立 russh 会话完成 50 MiB 与 200 MiB 高输出门禁。两轮发送与接收字节完全相等，4,000 个 64 KiB sequence block 顺序完整，overflow 为 0，Unicode/ANSI/OSC/alternate-screen reference 可见。

高输出期间另一条 SSH 会话持续执行输入探针。50/200 MiB 的输入 p95 分别为 306ms / 272ms，可见窗口 frame p95 均为 18ms。应用日志没有 ERROR、panic 或 fatal，远端临时 fixture 在结束后删除。

## 环境与复跑

| 项目 | 值 |
|---|---|
| 客户端 | Apple M2, macOS 26.1 (25B5072a) |
| 远端 | `root@100.83.112.82:22`，`/root/qclaw-wechat-client` |
| commit | `c005a2420960be49be51df778e27ba296b2be95c` |
| 构建 | optimized release M1 ssh benchmark bundle |
| bundle | 14,300 KiB |
| 命令 | `scripts/benchmark-m1-ssh-output.sh all` |
| 认证 | `~/.ssh/id_ed25519`，known_hosts fail-closed |

脚本从系统 SSH 配置解析 host/user/port/identity，先用 OpenSSH 验证连接，再上传 fixture 并比对 SHA-256。应用会话本身由 Tunara/russh 建立，凭证不写入正式应用配置；benchmark 使用隔离 Application Support。原始摘要见 [result-summary.json](./raw/m1-ssh-high-output-2026-07-11/result-summary.json)。

## 结果

| 指标 | 50 MiB | 200 MiB | 门禁 |
|---|---:|---:|---:|
| 收到字节 | 52,428,800 | 209,715,200 | 等于发送字节 |
| sequence blocks | 800/800 | 3,200/3,200 | 顺序完整 |
| Data IPC | 5,779 | 19,860 | 记录值 |
| 传输时间 | 173,128ms | 615,617ms | 记录值 |
| overflow | 0 | 0 | 必须为 0 |
| 最终 reference | 可见 | 可见 | 必须可见 |
| 对照 SSH 输入 p50 / p95 | 272 / 306ms | 268 / 272ms | 记录值 |
| frame samples | 301 | 301 | 至少 60 |
| frame p50 / p95 / max | 17 / 18 / 31ms | 17 / 18 / 20ms | p95 ≤ 33.4ms |
| xterm render drain | 19ms | 15ms | 记录值 |

当前真实链路本身较慢：系统 OpenSSH 原始 10 MiB / 50 MiB 对照分别为 34.42 秒 / 180.25 秒。Tunara 的 50 MiB 为 173.13 秒，与原始 SSH 同量级，未观察到客户端 batching 造成额外数量级退化。

SSH output batcher 使用 8ms / 128 KiB 双阈值。在慢链路下平均 Data IPC payload 约 8.9 KiB / 10.3 KiB，主要由 8ms 首包等待门触发；单包硬上限仍为 128 KiB。跨 transport 的 xterm ACK window 为 2 MiB，只有 xterm write callback 完成后才归还额度。

## 资源趋势

| 指标 | 结果 |
|---|---:|
| app RSS peak | 116,768 KiB |
| renderer 增量 RSS peak | 416,976 KiB |
| 总增量 RSS peak | 517,408 KiB |
| 总增量 RSS mean | 453,285.21 KiB |
| 首四分位 RSS mean | 479,629 KiB |
| 末四分位 RSS mean | 458,486 KiB |
| 最后样本 | 425,024 KiB |
| CPU mean | 4.78% |

末四分位 RSS 均值低于首四分位，最后样本也低于峰值，结果不支持 250 MiB 输出正文在线性驻留。WebGL context loss、DOM fallback、reference 可见与重新激活 WebGL 也在同一 SSH bundle 中通过。

## 剩余边界

- optimized bundle 的 SSH transport 中断、唯一 disconnected 证据与原位 reconnect 已完成，见 [恢复报告](./m1-ssh-recovery-2026-07-11.md)。
- 100/200ms RTT 集成层已有 5 样本统计，bundle 层恢复闭环也已完成。
- Claude Code、Codex、Pi、OpenCode、Aider 和未知 TUI 的本地/SSH 兼容矩阵仍待完成。
