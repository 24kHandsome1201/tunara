# M1 SSH 100/200ms RTT 操作基线（2026-07-11）

## 结论

真实 `de-netcup` 已通过 100ms 与 200ms 配置 RTT 下的 5 轮连接、cwd、4KiB preview、grep、diff、SFTP 目录读取和取消测试。所有 10 个 SSH session 均完成认证、操作和关闭；取消从 token 生效到命令返回的 p95 为 148.32ms / 233.42ms。

这是 russh 集成层的真实主机 harness，不是 optimized Tauri bundle UI 结果。它证明传输、channel 清理与取消语义；UI 缓存、交互状态和 bundle 帧时间仍需后续门禁。

## 方法

- 目标：`root@100.83.112.82:22`，工作目录 `/root/qclaw-wechat-client`。
- 本机随机端口用户态 TCP proxy 转发真实 SSH 流量；每方向分别延迟 50ms / 100ms，形成配置 100ms / 200ms request-response RTT。
- 不修改本机或远端网络规则，不影响其他连接。
- test-only host-key policy 只接受代理转发的真实 server key，不写入用户 `known_hosts`；生产策略仍保持 fail-closed/TOFU。
- 每档 5 个全新 SSH 连接；每个连接依次执行 `pwd`、4KiB preview、grep、Git diff stat、SFTP read-dir 和可取消 `sleep 30`。
- 运行命令：

```sh
TUNARA_SSH_SMOKE_HOST=100.83.112.82 \
TUNARA_SSH_SMOKE_USER=root \
TUNARA_SSH_SMOKE_CWD=/root/qclaw-wechat-client \
TUNARA_SSH_RTT_SAMPLES=5 \
cargo test --manifest-path src-tauri/Cargo.toml \
  real_ssh_rtt_operations_benchmark -- --ignored --nocapture
```

原始结构化结果：[result.json](./raw/m1-ssh-rtt-2026-07-11/result.json)。

## p50 / p95 / max（ms）

| 操作 | 100ms RTT | 200ms RTT |
|---|---:|---:|
| Connect | 2286.75 / 2445.13 / 2445.13 | 2876.93 / 2979.17 / 2979.17 |
| pwd / cwd | 812.39 / 852.93 / 852.93 | 1058.80 / 1084.69 / 1084.69 |
| Preview 4KiB | 867.79 / 928.40 / 928.40 | 1171.38 / 1369.38 / 1369.38 |
| grep | 872.98 / 923.57 / 923.57 | 1162.51 / 1174.43 / 1174.43 |
| Git diff stat | 864.03 / 898.59 / 898.59 | 1170.87 / 1174.60 / 1174.60 |
| SFTP read-dir | 2395.87 / 2553.90 / 2553.90 | 3087.62 / 3213.19 / 3213.19 |
| Cancel effective | 124.90 / 148.32 / 148.32 | 223.49 / 233.42 / 233.42 |

SFTP 首次读取包含 subsystem/channel 初始化，因此明显高于复用同一 exec transport 的小型命令。200ms 下 preview p95 的额外波动来自 4KiB 多包传输；本报告只记录事实，不用单次最低值替代统计。

## 剩余门禁

- optimized Tauri bundle 下复跑同样操作并记录 UI 状态、CPU/RSS/frame time。
- 增加目录连续导航与缓存对照、10MiB preview cap、10,000 项目录和并发 inspection。
- 增加断线、网络切换、睡眠唤醒、SFTP timeout 与恢复。
