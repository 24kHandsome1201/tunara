# M1 Agent / TUI 兼容性基线（2026-07-11）

## 结论

在固定 commit `ba9272498b473abbb1dcfb10aec9e72c4e93de10` 上，Claude Code、Codex、Pi、OpenCode、Aider 的本地 TTY 启动与 resize 均通过；真实 `de-netcup` SSH 上同样 5/5 通过。远端 Aider 固定安装在独立 `/opt/tunara-agent-tools/aider-0.86.2` venv，入口为 `/usr/local/bin/aider`，不污染远端项目依赖。

一个不受 Tunara hook 支持的确定性未知 TUI 在本地和 SSH 均完整通过：alternate screen 进入/恢复、bracketed paste、focus reporting、mouse tracking、True Color、CJK、emoji、256 行高输出、waiting、failure、resume、`40x120` resize 和中断退出后的模式恢复。

这证明了底层 PTY/SSH TTY 不依赖 Agent 品牌或私有 stdout 布局。交互探针还向 10 个真实 Agent 格发送了 `Esc`、Tab、Shift+Tab 和未提交的 bracketed 多行文本；8/10 能从绘制字节中观察到两行 marker。5/10 在 fallback 中断前完成 `/exit` 或 EOF 正常退出。

provider 层另有 4/10 完成真实响应：本地 Claude、本地 Codex、SSH Codex、SSH Aider；其中本地 Claude、本地 Codex、SSH Codex 有结构化 tool event 和完成 marker。其余 6 格为可复现环境阻塞或失败。完整 GOAL 仍要求首次权限、等待确认、失败/resume、Tunara 分屏、后台恢复和系统剪贴板逐格取证，因此 M1 状态保持未完成。

## 环境与复跑

| 项目 | 值 |
|---|---|
| macOS | 26.1 (25B5072a) |
| commit | `ba9272498b473abbb1dcfb10aec9e72c4e93de10` |
| SSH target | `de-netcup` |
| terminal identity | `TERM=xterm-256color`, `COLORTERM=truecolor` |
| TTY 命令 | `scripts/benchmark-m1-agent-tui.sh` |
| provider 命令 | `scripts/benchmark-m1-agent-provider.sh` |
| 脱敏摘要 | [TTY summary](./raw/m1-agent-tui-2026-07-11/result-summary.json) · [provider summary](./raw/m1-agent-tui-2026-07-11/provider-summary.json) |

脚本使用真实 PTY 启动每个 TUI，最多观察 10 秒首帧，把终端调整到 `40x120`，继续排空输出并执行安全输入/退出探针。harness 会像 xterm.js 一样回答 DEC mode、cursor position、像素尺寸、前景/背景色和 keyboard protocol 查询；否则 OpenCode/OpenTUI 会在裸 PTY 中等待并产生假失败。本轮本地/SSH 共回答 64 次终端查询，未知 TUI 也分别完成四类 query-response 自证。

日志只在私有临时目录存在；最终仅保存版本、字节数、协议布尔值、脱敏错误分类和 harness 结果，避免把账号、工作目录、文件内容或终端正文写入仓库。

## 版本矩阵

| Agent | 本地 | SSH |
|---|---|---|
| Claude Code | 2.1.178 | 2.1.81 |
| Codex | 0.144.1 | 0.144.1 |
| Pi / Oh My Pi | 0.79.4 | 0.79.4（通过 `npx`） |
| OpenCode | 1.17.18 | 1.17.18 |
| Aider | 0.86.2 | 0.86.2 |
| 未知 TUI | 确定性 fixture | 同一 fixture |

## TTY 启动与协议观察

`未观察` 表示该版本在启动画面中没有发出对应控制序列，不代表 Tunara 不支持该协议。只有未知 TUI 的协议行是强制合约。

| 环境 | Agent | 启动 + resize | alternate screen | bracketed paste | focus | mouse |
|---|---|---:|---:|---:|---:|---:|
| 本地 | Claude Code | 是 | 是，已恢复 | 是 | 是 | 是 |
| 本地 | Codex | 是 | 未观察 | 是 | 是 | 未观察 |
| 本地 | Pi | 是 | 未观察 | 是 | 未观察 | 未观察 |
| 本地 | OpenCode | 是 | 是 | 是 | 未观察 | 是 |
| 本地 | Aider | 是 | 未观察 | 是 | 未观察 | 未观察 |
| SSH | Claude Code | 是 | 未观察 | 是 | 是 | 未观察 |
| SSH | Codex | 是 | 未观察 | 是 | 是 | 未观察 |
| SSH | Pi | 是 | 未观察 | 是 | 未观察 | 未观察 |
| SSH | OpenCode | 是 | 是，已恢复 | 是 | 未观察 | 是 |
| SSH | Aider | 是 | 未观察 | 是 | 未观察 | 未观察 |

## 输入与正常退出观察

多行 marker 可见是终端绘制层证据；`未观察` 不等于输入丢失，因为部分 TUI 会重绘、隐藏或清空 prompt。正常退出只在进程于 fallback `Ctrl+C` 之前结束时记为通过。

| 环境 | Agent | 多行 marker 可见 | 正常退出观察 |
|---|---|---:|---|
| 本地 | Claude Code | 是 | `/exit` |
| 本地 | Codex | 是 | 未观察，fallback interrupt |
| 本地 | Pi | 是 | EOF |
| 本地 | OpenCode | 未观察 | 未观察，fallback interrupt |
| 本地 | Aider | 是 | provider 失败后提前退出 |
| SSH | Claude Code | 未观察 | provider 失败后提前退出 |
| SSH | Codex | 是 | EOF |
| SSH | Pi | 是 | EOF |
| SSH | OpenCode | 是 | 未观察，fallback interrupt |
| SSH | Aider | 是 | `/exit` |

## provider 与工具调用

| 环境 | Agent | 完成 marker | tool event | 结果 |
|---|---|---:|---:|---|
| 本地 | Claude Code | 是 | 是 | 只读 `package.json` 后完成 |
| 本地 | Codex | 是 | 是 | read-only sandbox 执行 `pwd` 后完成 |
| 本地 | Pi | 否 | 不适用 | 缺 API key |
| 本地 | OpenCode | 否 | 不适用 | 60 秒无输出超时 |
| 本地 | Aider | 否 | 不适用 | 缺 API key |
| SSH | Claude Code | 否 | 有事件但未完成 | provider 402 |
| SSH | Codex | 是 | 是 | read-only sandbox 执行 `pwd` 后完成 |
| SSH | Pi | 否 | 不适用 | 缺 API key |
| SSH | OpenCode | 否 | 不适用 | provider 401 |
| SSH | Aider | 是 | 不适用 | `gpt-4o-mini` 响应完成 |

Claude/Codex 的 `tool event` 从 JSON/JSONL 事件结构确认，不用最终自然语言自报代替。SSH Claude 虽出现 tool-shaped 事件，但没有完成 marker 且返回 402，因此仍记失败。

## 未知 TUI 合约

| 断言 | 本地 | SSH |
|---|---:|---:|
| alternate screen 进入与恢复 | 通过 | 通过 |
| bracketed paste | 通过 | 通过 |
| focus reporting | 通过 | 通过 |
| mouse tracking | 通过 | 通过 |
| True Color | 通过 | 通过 |
| CJK 与 emoji 原始字节完整 | 通过 | 通过 |
| 256 行高输出完成标记 | 通过 | 通过 |
| waiting / failure / resume 标记 | 通过 | 通过 |
| `SIGWINCH` 后观察 `40x120` | 通过 | 通过 |
| 中断退出并恢复终端模式 | 通过 | 通过 |

## 剩余完成门

以下每项都必须产生本地和 SSH 的逐 Agent 证据，不能用未知 fixture 或单次启动替代：

- 首次权限提示与拒绝/允许路径。
- 多行输入、Tab、Shift+Tab、方向键、`Esc`、`Ctrl+C`、`Ctrl+R` 的逐键结果；当前只完成安全发送和部分可见 marker。
- 真实工具调用、高输出、等待确认、完成和失败。
- resume 到同一会话，而不是重新启动一个同名 Agent。
- Tunara 内实际分屏 resize、侧栏/Inspector 展开后的最小几何。
- 窗口后台再恢复时输入状态、scrollback 和 alternate-screen 所有权。
- 系统剪贴板复制、普通粘贴与 bracketed paste。
- Codex/OpenCode 的稳定正常退出命令，以及每个 Agent 退出后的普通 shell 恢复。

涉及外部账号或 provider 的失败必须记录为环境阻塞，不能把 CLI 启动画面当作模型调用成功。
