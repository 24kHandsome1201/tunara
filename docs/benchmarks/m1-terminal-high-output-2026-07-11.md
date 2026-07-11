# M1 本地终端 50/200 MiB 高输出基线（2026-07-11）

## 结论

真实 optimized macOS bundle 已通过 50 MiB 与 200 MiB 混合终端输出门禁：每个 64 KiB 序列块按顺序完整到达，前端 backlog 溢出为 0，alternate screen 退出后的 Unicode/ANSI reference 可见，5 秒可见窗口 frame p95 分别为 18ms / 19ms，低于 33.4ms 预算。

这份报告证明本地 PTY 高输出链路和 renderer 最终检查点。后续 optimized bundle 已补跑真实 WebGL context loss、DOM fallback、WebGL 重建与 38 分 44 秒压力门禁；SSH 高输出仍需单独完成。

## 环境与复跑

| 项目 | 值 |
|---|---|
| 硬件 | Apple M2, arm64 |
| 系统 | macOS 26.1 (25B5072a) |
| 代码基线 | `3609640782aaccba41ed3c885773a1897245542e` + 本报告同批未提交实现 |
| 构建 | optimized release benchmark bundle |
| Bundle identifier | `dev.tunara.m1benchmark` |
| Bundle 大小 | 14,300 KiB |
| 命令 | `scripts/benchmark-m1-terminal-output.sh all` |

fixture 每 64 KiB 写入固定序列头，正文覆盖 ANSI/True Color、OSC title、粗体、CJK、emoji、宽字符、组合字符、连字样本、光标移动、清行与 alternate screen。最终退出 alternate screen 并写入 `TUNARA_M1_OK 中文 🐟 é 界 ┌─┐`，benchmark 在 xterm write barrier 后读取序列化 reference。

原始结果：[result.json](./raw/m1-terminal-output-2026-07-11/result.json)；进程采样：[process-samples.csv](./raw/m1-terminal-output-2026-07-11/process-samples.csv)。benchmark bundle 使用隔离 Application Support，不读取或覆盖正式 Tunara 会话。

## 结果

| 指标 | 50 MiB | 200 MiB | 门禁 |
|---|---:|---:|---:|
| 收到字节 | 52,428,800 | 209,715,200 | 等于发送字节 |
| 序列块 | 800/800 | 3,200/3,200 | 顺序完整 |
| Data IPC | 401 | 1,601 | 记录值 |
| 传输并渲染窗口耗时 | 6,428ms | 26,415ms | 记录值 |
| 前端 backlog 溢出 | 0 | 0 | 必须为 0 |
| 最终 reference | 可见 | 可见 | 必须可见 |
| 对照终端输入 p95 | 28ms | 26ms | 记录值 |
| frame samples | 300 | 300 | 至少 60 |
| frame p50 / p95 / max | 17 / 18 / 27ms | 17 / 19 / 25ms | p95 ≤ 33.4ms |

整轮进程采样：app RSS peak 122,032 KiB，renderer 增量 RSS peak 589,232 KiB，PTY RSS peak 9,568 KiB，总增量 RSS peak 720,432 KiB、末样本 644,864 KiB，CPU mean 10.45%。单轮结果没有出现随输入字节等比例保存 250 MiB 正文的行为，但是否长期稳定仍由 30 分钟压力门验证。

## WebGL context loss 与 DOM fallback

使用 `WEBGL_lose_context` 在真实 WebGL renderer 上触发 context loss。xterm 为原生 context restore 保留 3 秒窗口，超时后 Tunara 自动释放失效 addon、清理 renderer registry、刷新全部可见行并切换到 DOM renderer。fallback 后写入的 reference 可见；切换到另一终端再返回后，新 WebGL context 成功建立。

| 检查点 | 结果 |
|---|---|
| context loss 前 | WebGL |
| context loss 触发 | 成功，renderer extension |
| 3 秒恢复窗口后 | DOM fallback |
| fallback 后 reference | 可见 |
| 终端重新激活后 | WebGL |

同轮回归中 50/200 MiB 仍顺序完整、overflow 为 0，输入 p95 为 22/23ms，frame p95 均为 18ms。原始摘要见 [result.json](./raw/m1-webgl-fallback-2026-07-11/result.json)。测试触发器由 benchmark compile flag 隔离，普通 production build 不包含 `WEBGL_lose_context` 或 benchmark marker。

## 发现并修复的问题

第一次 1 MiB 校准暴露本地 PTY 在 1 MiB pending cap 后主动删除输出。修复后 reader 使用约 1 MiB 的有界同步队列；队列满时由内核 PTY 反压子进程，flusher 以 16ms / 128 KiB 聚合，不再切断 UTF-8、ANSI 或 OSC 字节流。

第一次正式 50/200 MiB 运行随后暴露前端分别丢弃 21 / 91 次 backlog，200 MiB frame p95 为 100ms。最终实现增加跨本地/SSH 的 2 MiB 消费窗口：xterm write callback 后前端才归还额度；每次 xterm 写入最多 128 KiB，并在上一批解析完成后的下一帧继续。复测溢出归零，frame p95 降到 18 / 19ms，CPU mean 从失败运行的 18.16% 降到 10.45%。

## 剩余边界

- SSH 50/200 MiB 与 100/200ms RTT 已完成；optimized bundle 断线恢复仍待补齐。
- WebGL context loss、DOM fallback 与重新激活 WebGL 已完成；主题/字体切换和真实截图矩阵尚未完成。
- 38 分 44 秒、16 GiB、四档 resize 与 18 次隐藏/恢复压力已完成，见[长压报告](./m1-terminal-stress-2026-07-11.md)。
- renderer RSS 长压末四分位均值低于首四分位，平台缓存已在 38 分钟证据内确认可回收并收敛。
