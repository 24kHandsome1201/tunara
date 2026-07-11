# M1 Terminal + SSH 关闭审计（2026-07-12）

## 结论

M1 按 [实施规格](../M1_TERMINAL_SSH_PERFORMANCE.md) 关闭。冷启动与 12 PTY、本地/SSH 50/200 MiB 高输出、输入字节预算、Close/Resize 控制面、100/200ms RTT、断线原位恢复、WebGL/DOM fallback、38 分钟长压和 Agent/TUI 终端语义均有可复跑或真实 bundle 证据，未留下 M1 产品缺陷。

Agent 外部 provider 的账号、凭据、组织策略与真实模型响应不是 M1 完成门。[GOAL](../GOAL.md) 明确不做内置模型 API、模型路由、计费或云端对话服务；M1 只要求 Tunara 在 provider 成功、失败或不可用时保持真实 PTY、安全降级和诚实状态。这些环境格继续保留在 [Agent / TUI 兼容性基线](./m1-agent-tui-compatibility-2026-07-11.md) 中，不伪报为 provider 成功，也不再阻塞 Phase 2。

## 合同对照

| M1 要求 | 权威证据 | 判定 |
|---|---|---|
| 冷启动、首 PTY、12 session、bundle 与输入延迟 | [启动报告](./m1-terminal-startup-2026-07-11.md)：5/5 轮 12/12 ready，输入 p95 中位数 27ms，RSS peak 中位数 413,088 KiB | 通过 |
| 本地 50/200 MiB、Unicode/ANSI/OSC/alternate screen | [本地高输出](./m1-terminal-high-output-2026-07-11.md)：顺序完整，overflow 0，frame p95 18/19ms | 通过 |
| 输入 backpressure、Close 独立取消、Resize latest-value、输出有界批处理 | [SSH 控制面](./m1-ssh-control-2026-07-11.md)：256 KiB 预算、1,024 消息上限、8ms/128 KiB batch、真实 `de-netcup` smoke | 通过 |
| SSH 50/200 MiB 无丢字与无界增长 | [SSH 高输出](./m1-ssh-high-output-2026-07-11.md)：4,000 序列块完整，overflow 0，frame p95 18ms，末四分位 RSS 均值下降 | 通过 |
| 100/200ms RTT 的 cwd/preview/grep/diff/SFTP/取消 | [RTT 报告](./m1-ssh-rtt-harness-2026-07-11.md)：每档 5 个全新连接，10/10 session 完成 | 通过 |
| 断线证据、唯一 exit 与原位恢复 cwd | [恢复报告](./m1-ssh-recovery-2026-07-11.md)：279ms 唯一 `-2`，2,888ms 原位 reconnect，命中原 cwd marker | 通过 |
| WebGL context loss、DOM fallback、后台 flush 和 30 分钟以上长压 | [长压报告](./m1-terminal-stress-2026-07-11.md)：38m44s、16 GiB、64/64 fixture、overflow 0，fallback 往返通过 | 通过 |
| Agent/TUI 本地与 SSH 终端语义 | [兼容性基线](./m1-agent-tui-compatibility-2026-07-11.md)：5+5 真实 Agent 启动/resize，10/10 菜单、历史、多行、取消、退出，未知 TUI 完整协议合同 | 通过 |
| 普通 production build 不携带 benchmark 触发器 | [本地高输出](./m1-terminal-high-output-2026-07-11.md) 与 [SSH 恢复](./m1-ssh-recovery-2026-07-11.md) 均记录普通 build 无 marker/触发命令 | 通过 |

## 遗留环境附录，不阻塞 M1

- SSH Claude provider 402、SSH Pi 生产 key 缺失、OpenCode/Aider 凭据认证失败继续按环境事实记录；Tunara 不配置或修复用户的外部账号。
- 本地 Claude 组织策略不产生人工确认，不能用自报或伪造 prompt 代替；结构化 hook 与 Codex 确认 fallback 的产品状态合同已通过。
- ScreenshotDaemon 对当前原生窗口返回桌面背景，但这不否定已保存的 xterm snapshot、辅助技术树、PTY cols/rows 和定量布局不变量。自动截图层级问题保留为本机 QA 工具限制，不冒充像素证据。

## 决策

M1 从 Active Milestone 移出，进入回归集。下一个唯一 Active Milestone 是 Phase 2 Markdown / 单文件轻编辑，严格按冲突检测、本地安全写和 SSH 临时文件+原子替换的完成门执行。
