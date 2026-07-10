# M1 SSH 输入控制面与输出批处理证据（2026-07-11）

## 结论

M1 的第一批 SSH 热路径改造已通过本地确定性测试和真实 `de-netcup` smoke：输入按 256 KiB 字节预算限流，单次粘贴全有或全无；Close 不排在 Data/Resize 后并可重复调用；Resize 只保留最新值；输出以 8ms / 128 KiB 双阈值有界批处理并在退出前 flush。

本报告只证明控制面与 128 KiB 真实输出链路。50/200 MiB fixture、100/200ms RTT、CPU/RSS/frame time 和 30 分钟压力仍属于后续门禁，未据此宣告 M1 完成。

## 环境与实现边界

- 本机：Apple Silicon (`arm64`)，macOS 26.1 (25B5072a)。
- 基线 parent commit：`0e80f7c107ea7daec5349ccfd987b8a4337b85a3`。
- 真实主机：SSH 配置项 `de-netcup`，测试连接 `root@100.83.112.82:22`，使用本机 SSH agent；报告不记录凭证、终端正文或远端敏感数据。
- 输入预算：256 KiB，同时保留 1,024 条消息上限以限制极小消息对象开销。
- 网络写块：32 KiB；预算包含正在等待 SSH flow control 的 in-flight batch。
- 输出批处理：首包最长等待 8ms，单个 Data 事件最大 128 KiB；EOF/Close/错误退出前 flush 尾包。

## 自动化证据

`cargo test --manifest-path src-tauri/Cargo.toml`：142 passed，1 个真实网络测试默认 ignored，0 failed。

新增确定性覆盖：

1. 满 256 KiB 后拒绝额外输入，且 dequeue 后、网络发送完成前仍占用预算。
2. 1,024 条极小输入后拒绝额外消息，避免只看字节数造成对象级无界增长。
3. 满输入队列下 Close 仍在 50ms 测试窗口内可见，重复 Close 幂等；关闭后 Data/Resize 明确失败。
4. 连续 Resize 只向消费者暴露最终 `132x43`。
5. 输出跨 128 KiB 边界拆包后字节顺序不变，尾包可 flush。

全量门禁：Node 400/400、Rust 142/142；TypeScript typecheck、ESLint、production build、Rust fmt 与 Clippy 均通过。

## 真实 SSH smoke

运行：

```sh
TUNARA_SSH_SMOKE_HOST=100.83.112.82 \
TUNARA_SSH_SMOKE_USER=root \
cargo test --manifest-path src-tauri/Cargo.toml \
  real_ssh_control_and_output_batch_smoke -- --ignored --nocapture
```

观测结果：

- 系统 SSH BatchMode 预检成功。
- Tunara SSH session 建连成功。
- 连续提交 `90x30` 与 `132x43` resize 后，输出 128 KiB `x` fixture 和唯一 marker。
- 两次有效运行均收到 131,911 bytes；分别为 21 / 16 个 Data 事件，用时约 1,100 / 1,120ms。
- marker 只在完整 131,072 个 `x` 之后判定成功，避免把终端命令回显误当成完成。
- 连续两次 Close 成功，并在 5 秒门限内收到唯一 Exit 事件。

## 后续门禁

- 50/200 MiB Unicode/ANSI/OSC/alternate-screen fixture 与 reference capture。
- 100/200ms RTT 下连接、目录、preview、grep、diff、取消与恢复的 p50/p95/max。
- IPC/CPU/RSS/frame time 的同条件对照，以及 WebGL fallback/context loss。
- optimized macOS bundle 的 30 分钟压力与断网恢复。
