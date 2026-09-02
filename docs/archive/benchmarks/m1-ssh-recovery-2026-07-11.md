# M1 SSH 断线与原位恢复证据（2026-07-11）

## 结论

真实 optimized macOS bundle 在 `de-netcup` 会话级 transport 被强制中断后，279ms 内收到唯一 `-2` exit，连接证据明确进入 `disconnected`。同一逻辑 session 原位 reconnect 用时 2,888ms，writer generation 从 1 变为 2；恢复后远端返回的 `marker:$PWD` 精确命中 `/root/qclaw-wechat-client`，状态回到 `ready`。

测试只杀死当前 SSH 会话对应的远端 `sshd` 子进程，不修改网络规则、不停止 sshd listener、不影响其他连接。测试结束后远端 `ssh.service` 仍为 `active`，临时 fixture 已删除。

## 环境与复跑

| 项目 | 值 |
|---|---|
| 客户端 | Apple M2, macOS 26.1 (25B5072a) |
| 远端 | `root@100.83.112.82:22` |
| cwd | `/root/qclaw-wechat-client` |
| commit | `2c5d7f4d97067c53145fed9c4e2d12e80c6c1b06` |
| 构建 | optimized release M1 ssh benchmark bundle |
| 命令 | `scripts/benchmark-m1-ssh-output.sh run` |

benchmark 先完成 1 MiB Unicode/ANSI/OSC/alternate-screen fixture，再向高输出会话发送 `kill -9 "$PPID"`。这里的 `$PPID` 是该交互 shell 的会话级 sshd 父进程，不是 `/usr/sbin/sshd -D` listener。原始摘要见 [result-summary.json](./raw/m1-ssh-recovery-2026-07-11/result-summary.json)。

## 状态与时序

| 检查点 | 结果 |
|---|---:|
| transport exit code | `-2` |
| exit event | 1 次，重连后仍为 1 次 |
| disconnect latency | 279ms |
| disconnected phase | `disconnected` |
| evidence exit code | `-2` |
| writer generation | 1 -> 2 |
| reconnect latency | 2,888ms |
| 恢复 marker echo | 428ms |
| 恢复 cwd | `/root/qclaw-wechat-client` |
| cwd reference | 可见 |
| 恢复 phase | `ready` |

这条门禁同时防止三类假恢复：把 transport loss 误报成 exit 0、旧 TerminalView/writer 没有真正替换、以及重连成功但 cwd 静默回落到 home。

## 同轮渲染与资源

1 MiB 校准 fixture 收发 1,048,576 bytes、16/16 sequence blocks、overflow 为 0、reference 可见；输入 p95 277ms，frame p95 18ms。总增量 RSS peak 410,432 KiB、mean 344,344.39 KiB，CPU mean 4.17%。

普通 production build 已确认不包含恢复命令、marker 或 benchmark 错误字符串；断线触发器只存在于 compile-time benchmark bundle。

## 剩余边界

- 网络接口切换和整机睡眠唤醒需单独运行，不能与防锁屏压力同时证明。
- 私钥需要口令或密码认证时，产品仍要求用户在重连对话框重新输入一次性凭证；本轮使用无需口令的指定 identity file。
