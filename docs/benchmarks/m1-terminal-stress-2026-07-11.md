# M1 终端 38 分钟压力回归（2026-07-11）

## 结论

真实 optimized macOS bundle 连续运行 38 分 44 秒，完成 64 × 256 MiB，共 16 GiB 混合 Unicode/ANSI/OSC/alternate-screen 输出。64 轮全部字节相等、序列完整、overflow 为 0、最终 reference 可见；同时执行四档窗口 resize、18 次隐藏与恢复、每轮对照终端输入和可见窗口 frame 采样。

WebGL context loss -> DOM fallback -> reference 可见 -> 重新激活 WebGL 同轮通过。长压期间应用日志没有 ERROR、panic 或 fatal，输入 p95 最差 30ms，可见窗口 frame p95 最差 19ms，低于 33.4ms 预算。

## 环境与复跑

| 项目 | 值 |
|---|---|
| 硬件 | Apple M2, arm64 |
| 系统 | macOS 26.1 (25B5072a) |
| commit | `8443458815d38f90a79871c907092f0b67dbe04e` |
| 构建 | optimized release M1 benchmark bundle |
| bundle | 14,300 KiB |
| 命令 | `scripts/stress-m1-terminal-output.sh` |
| 持续时间 | 2,324 秒，38 分 44 秒 |

默认脚本生成 64 个 256 MiB fixture。每 15 秒在 720×520、1040×680、820×600、1180×760 之间 resize；每 8 次 resize 隐藏窗口 5 秒再恢复。后台导致的 rAF 暂停单独记录，只对可见 frame delta 应用 33.4ms 预算；输出顺序、reference、overflow 和输入探针在前后台都继续作为硬门禁。

摘要原始证据见 [result-summary.json](./raw/m1-terminal-stress-2026-07-11/result-summary.json)。

## 正确性与响应

| 指标 | 结果 |
|---|---:|
| fixture | 64/64 通过 |
| 总输出 | 17,179,869,184 bytes，16 GiB |
| 64 KiB sequence blocks | 262,144/262,144 |
| Data IPC | 131,144 |
| sequence failure | 0 |
| overflow | 0 |
| reference failure | 0 |
| 对照终端输入 p95 | 22-30ms |
| 可见窗口 frame p95 | 18-19ms |
| 可见窗口单帧 max | 31ms |
| xterm render drain max | 273ms |
| 后台 rAF 暂停 fixture | 1，按后台证据分类且输出门禁通过 |

窗口刺激共记录 145 次成功 resize、18 次 hide、18 次 show。首次 resize 在 Tauri window 尚未创建时失败 1 次并被显式记录，后续操作全部成功。

## 资源趋势

| 指标 | 结果 |
|---|---:|
| app RSS peak | 119,584 KiB |
| renderer 增量 RSS peak | 627,632 KiB |
| PTY RSS peak | 10,064 KiB |
| 总增量 RSS peak | 739,456 KiB |
| 总增量 RSS mean | 516,063.68 KiB |
| 首四分位 RSS mean | 556,945 KiB |
| 末四分位 RSS mean | 487,138 KiB |
| 最后样本 | 491,328 KiB |
| CPU mean | 10.08% |

末四分位均值比首四分位低约 12.5%，最后样本显著低于启动预热峰值。结果不支持输出正文随累计 16 GiB 线性驻留；renderer 缓存存在周期性波动，但在本轮内可回收并收敛。

## 剩余边界

- SSH 50/200 MiB 高输出仍需与本地结果对照。
- 主题、字体、连字开关、IME 和真实截图矩阵仍需补齐。
- 睡眠唤醒不与本轮防锁屏压力同时执行，需单独做恢复回归。
