# M2 macOS 首 PTY 冷启动性能闭环（2026-07-13）

## 结论

基于提交 `041ac4581864568d5e0e0389f8ac81bd5968b2c2` 的 optimized macOS benchmark app 连续完成 5 次独立进程启动。每轮启动前均确认上一进程完全退出，重新创建 12 个真实本地 PTY，并以真实写入 marker 返回作为可输入判据；5 轮均为 12/12 ready、输入探针 0 failure。

首 PTY 可输入中位数为 **1,619ms**。M1 中位数 1,639ms 的 1.1 倍预算为 **1,802.9ms**，本轮低 183.9ms，比例为 0.9878，因此通过 Phase 2 硬门。没有放宽阈值、减少真实 PTY、保留隐藏预热进程、跳过输入探针或使用 dev/mock/Linux 结果。

## 环境与方法

| 项目 | 值 |
|---|---|
| 提交 | `041ac4581864568d5e0e0389f8ac81bd5968b2c2` |
| 构建 | `VITE_TUNARA_BENCHMARK=m0` optimized release app bundle |
| fixture | 12 个本地 session / TerminalView / 真实 PTY |
| 命令 | `TUNARA_BENCHMARK_RESULTS=/tmp/tunara-m2-startup-2026-07-13 scripts/benchmark-m0-terminals.sh series` |
| 独立性 | 每轮 `pkill` 指定 bundle、运行结束 `kill + wait`，再开始下一轮；5 个不同 PID |
| 窗口 | System Events 只读观察目标 PID 的 `visible + window count` |
| 首 PTY | WebView `performance.timeOrigin + performance.now()` 与真实 PTY 输入 marker 返回 |
| 资源 | 250ms 采样 app、PTY 与 WebKit 增量 RSS；保留输入/frame p95 和 bundle 大小 |

这里的“冷启动”沿用 M1 合同：app 进程完全退出后的独立启动，不声称重启 macOS 后的磁盘冷缓存或首次 Gatekeeper 校验。

## 5-run 明细

| 轮次 / PID | 窗口可见 | 首 PTY 可输入 | 全部 PTY 可输入 | ready / 输入失败 | 输入 p95 | frame p95 | RSS peak | bundle |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 / 53170 | 2,247ms | 3,885ms | 3,930ms | 12 / 0 | 73ms | 19ms | 409,184KiB | 14,396KiB |
| 2 / 54034 | 695ms | 1,831ms | 1,839ms | 12 / 0 | 24ms | 18ms | 405,696KiB | 14,396KiB |
| 3 / 55756 | 532ms | 1,619ms | 1,622ms | 12 / 0 | 22ms | 18ms | 407,024KiB | 14,396KiB |
| 4 / 56571 | 496ms | 1,591ms | 1,594ms | 12 / 0 | 24ms | 19ms | 404,592KiB | 14,396KiB |
| 5 / 57363 | 468ms | 1,564ms | 1,569ms | 12 / 0 | 22ms | 18ms | 402,592KiB | 14,396KiB |
| **中位数** | **532ms** | **1,619ms** | **1,622ms** | **12 / 0** | **24ms** | **18ms** | **405,696KiB** | **14,396KiB** |

刚完成 optimized build 后的第一轮明显慢于其余四轮，首 PTY 为 3,885ms、输入 p95 为 73ms；原始结果完整保留。验收合同使用 5-run 中位数抑制一次性系统调度与缓存抖动，且没有删除或替换该样本。每轮 frame p95 均不超过 33.4ms；输入 p95 中位数 24ms 不超过 29.9ms；RSS peak 中位数 405,696KiB 不超过 467,654KiB。

## 首屏静态模块图

optimized 前端产物为：入口 `main-C-mw283s.js` 2,960 bytes、首屏 `App-CZi7lqN3.js` 484,596 bytes、按需 `FilePreview-CJKRvzfr.js` 28,129 bytes（SHA-256 `2165cf212b739873895821118422d573ead11aedd59350d35fd417aafdce6671`）。

- `index.html` 与入口 chunk 对 `FilePreview` chunk 的引用均为 0。
- `App` chunk 只有 `import("./FilePreview-CJKRvzfr.js")` 动态边界；动态 chunk 存在不等于首屏加载。
- Markdown parser、源码高亮和 editor draft 实现均打包在 `FilePreview` chunk 内，初始静态入口图不加载这些实现。

因此 Phase 2 新增的 FilePreview / Markdown parser / editor draft 代码没有进入首 PTY 冷启动的初始静态模块图。

## Phase 2 关闭判断

`docs/GOAL_STATUS.md` 的 Phase 2 required gates 在本批前除首 PTY 性能外均已有真实证据。本轮补齐唯一未完成项并通过硬预算，因此 **Phase 2 正式完成**。Phase 3 Preview 保持未开始，本批不自动启动 Phase 3，也未重复原生关闭、本地保存、SSH/Linux 完整性、签名、公证或发布验收。

原始固化汇总见 [result-summary.json](./raw/m2-terminal-startup-macos-2026-07-13/result-summary.json)。
