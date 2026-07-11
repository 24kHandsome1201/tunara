# M1 Agent / TUI 兼容性基线（2026-07-11）

## 结论

在固定 commit `ba9272498b473abbb1dcfb10aec9e72c4e93de10` 上，Claude Code、Codex、Pi、OpenCode、Aider 的本地 TTY 启动与 resize 均通过；真实 `de-netcup` SSH 上同样 5/5 通过。远端 Aider 固定安装在独立 `/opt/tunara-agent-tools/aider-0.86.2` venv，入口为 `/usr/local/bin/aider`，不污染远端项目依赖。

一个不受 Tunara hook 支持的确定性未知 TUI 在本地和 SSH 均完整通过：alternate screen 进入/恢复、bracketed paste、focus reporting、mouse tracking、True Color、CJK、emoji、256 行高输出、waiting、failure、resume、`40x120` resize 和中断退出后的模式恢复。

这证明了底层 PTY/SSH TTY 不依赖 Agent 品牌或私有 stdout 布局。交互探针依次发送 `Esc`、Tab、Shift+Tab、四个方向键、`Ctrl+R`、未提交的 bracketed 多行文本和 `Ctrl+C`：当前 10/10 真实 Agent 格均收到完整 10 类探针。历史 SSH Claude 在第 6 类后提前退出；2026-07-12 使用已有 true 信任记录的空临时目录、plan mode 与当前 harness 重测，得到 `interaction_mask=1023`、两行 marker 相邻可见、`/exit` 正常退出且状态码 0。两次 trust prompt 前置尝试均沿安全退出路径关闭，不计 transport 失败；临时目录和 raw log 已删除，见 [脱敏补充](./raw/m1-agent-tui-2026-07-11/ssh-claude-input-supplement.json)。完整发送仍不能替代逐 Agent 的补全、选择、历史、取消和多行编辑语义验证。

provider 快照层有 4/10 完成真实外部响应：本地 Claude、本地 Codex、SSH Codex、SSH Aider；其中本地 Claude、本地 Codex、SSH Codex 有结构化 tool event 和完成 marker。后续 session 层已覆盖 10/10 本地/SSH Agent 格，其中本地 Claude、本地 Codex、本地 Pi、SSH Codex 完成真实外部 provider 上下文 resume；本地 Pi 用固定 UUID 产生 18 个 JSON event，first/resume marker 均命中，证明 provider 状态已较早期“缺 key”快照发生漂移。本地/SSH Aider 的显式 history 身份已落盘，但当前 key 无法认证；SSH Claude 固定 UUID 身份已落盘，但两轮均是 402；OpenCode 两端均确认进入同一专用 session，但本地 timeout、SSH 凭据错误；SSH Pi 的生产 provider 探针仍在创建 session 前缺 key。另一个受控探针已在真实 `de-netcup` 用 Pi 0.79.4、固定 session UUID 与仅绑定 `127.0.0.1` 的确定性 Chat Completions 端点完成两轮上下文重放；这只证明 Pi CLI 的 provider 协议/session 子层，不计入 4/10 外部 provider 响应，也不代表 Tunara UI 恢复按钮通过。安装版 Tunara 1.14.0 中的未知 TUI 还完成了真实分屏 resize、后台切回、快速复制和中断后 shell 恢复。完整 GOAL 仍要求逐 Agent 本地/SSH 交互证据，因此 M1 状态保持未完成。

## 环境与复跑

| 项目 | 值 |
|---|---|
| macOS | 26.1 (25B5072a) |
| commit | `ba9272498b473abbb1dcfb10aec9e72c4e93de10` |
| SSH target | `de-netcup` |
| terminal identity | `TERM=xterm-256color`, `COLORTERM=truecolor` |
| TTY 命令 | `scripts/benchmark-m1-agent-tui.sh` |
| provider 命令 | `scripts/benchmark-m1-agent-provider.sh` |
| session 命令 | `scripts/benchmark-m1-agent-session.sh` |
| 脱敏摘要 | [TTY summary](./raw/m1-agent-tui-2026-07-11/result-summary.json) · [provider summary](./raw/m1-agent-tui-2026-07-11/provider-summary.json) · [session summary](./raw/m1-agent-tui-2026-07-11/session-summary.json) · [SSH Pi loopback resume](./raw/m1-agent-tui-2026-07-11/ssh-pi-loopback-resume-summary.json) · [app runtime summary](./raw/m1-agent-tui-2026-07-11/app-runtime-summary.json) |

脚本使用真实 PTY 启动每个 TUI，最多观察 10 秒首帧，把终端调整到 `40x120`，继续排空输出并执行逐键输入/退出探针。harness 为每类已发送按键记录独立 bit，避免把“计划发送”误当作“进程存活期间已发送”；同时会像 xterm.js 一样回答 DEC mode、cursor position、像素尺寸、前景/背景色和 keyboard protocol 查询，否则 OpenCode/OpenTUI 会在裸 PTY 中等待并产生假失败。本轮本地/SSH 共回答 64 次终端查询，未知 TUI 也分别完成四类 query-response 与全部 10 类输入的自证。

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

“完整探针”只证明 harness 在进程存活期间完成了 10 类发送；多行 marker 可见才是终端绘制层证据。`未观察` 不等于输入丢失，因为部分 TUI 会重绘、隐藏或清空 prompt。正常退出只在 fallback 中断之前自然结束，或退出探针确实完成后记为通过。

| 环境 | Agent | 10 类探针完整发送 | 多行 marker 可见 | 正常退出观察 |
|---|---|---:|---:|---|
| 本地 | Claude Code | 是 | 未观察 | `/exit` |
| 本地 | Codex | 是 | 是 | 未观察，fallback interrupt |
| 本地 | Pi | 是 | 是 | EOF |
| 本地 | OpenCode | 是 | 未观察 | 未观察，fallback interrupt |
| 本地 | Aider | 是 | 是 | `/exit` |
| SSH | Claude Code | 否，第 6 类后提前退出 | 未观察 | 未观察，provider 失败后提前退出 |
| SSH | Codex | 是 | 是 | EOF |
| SSH | Pi | 是 | 是 | EOF |
| SSH | OpenCode | 是 | 是 | 未观察，fallback interrupt |
| SSH | Aider | 是 | 是 | `/exit` |

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

## 首次权限与 resume

| 环境 | Agent | 首次权限 / 信任 | resume |
|---|---|---|---:|
| 本地 | Claude Code | 显式 default 模式下组织策略仍自动允许专用 `/tmp` touch，未出现人工确认 | 通过，明确 session UUID + 上下文 token |
| 本地 | Codex | 通过，观察到目录信任提示及 prompt-injection 风险文案 | 通过，明确 thread UUID + 上下文 token |
| SSH | Codex | 本轮未重复目录信任 | 通过，明确 thread UUID + 上下文 token |
| SSH | Aider | 非交互 `--message` 无人工确认 | 阻塞：显式 history 文件已保留身份，但当前 provider key 无法认证 |
| 本地 | OpenCode | 不使用 `--auto`，本轮未进入权限问题 | 阻塞：专用 session 身份已确认，first/resume 均 60 秒零事件 timeout |
| SSH | OpenCode | 不使用 `--auto`，本轮未进入权限问题 | 阻塞：专用 session 身份已确认，两轮共 2 个凭据错误 JSON event |
| 本地 | Pi | 禁用所有工具与项目扩展，不需人工确认 | 通过：固定 session UUID，18 个 JSON event，first/resume 上下文 token 命中 |
| SSH | Pi | 禁用所有工具与项目扩展 | 生产 provider 阻塞：固定 `npx` 0.79.4 在创建 session 前返回缺 key；受控协议层通过：loopback-only stub 以固定 session UUID 完成两轮上下文重放，不计外部 provider 成功 |
| SSH | Claude Code | `dontAsk` 且不请求工具 | 阻塞：固定 UUID 身份已确认，两轮共 2 个 provider 402 JSON event |
| 本地 | Aider | 非交互 `--message`，禁用 Git/自动提交 | 阻塞：隔离 uvx 的 history 身份已确认，当前 provider key 无法认证 |

Claude 的探针文件在运行后清理。这里的“组织策略自动允许”是环境事实，不是 waiting-for-human 通过；不能为了填满矩阵而把自动执行伪装成权限提示。Codex trust smoke 不选择“继续”，由中断退出；resume 使用另一个已信任的临时目录和 read-only sandbox。

在 `15d1d60` 上重新盘点时，本地 OpenCode 已列出 MiniMax API 与 OpenAI OAuth，SSH OpenCode 已列出 OpenAI OAuth，但真实临时 session 探针仍分别为 3 次 timeout 与 2 个认证错误事件；两端 session 身份都能创建并在探针后删除。本地/SSH Aider 的隔离 history 也都保存上下文 token，但两轮均明确归类为 key 无法认证。复验未记录 credential 值，raw 日志、临时 session 与 history 已清理，见 [脱敏复验摘要](./raw/m1-agent-tui-2026-07-11/provider-resume-recheck-summary.json)。这证明身份持久化路径没有回归，同时也证明“凭据条目存在”不能替代 provider 成功。

### SSH Pi 受控 provider 协议层证据

`de-netcup` 上的真实 Pi 0.79.4 通过固定 session UUID 和单一 JSONL 向仅绑定 `127.0.0.1` 的确定性 Chat Completions stub 发出两轮主请求。第二轮请求同时重放首轮 user context token 与 assistant marker；first/resume 均退出 0，两个响应 marker 命中。Pi 还发出 2 次内部辅助请求，因此真实总数为 4，而不是把辅助流量隐去后声称只有 2 次请求。stub 使用每次随机生成且不落证据的 Bearer token，4 次请求全部认证并来自 loopback；工具、skills、extensions 和项目 context files 均关闭。临时 HOME、npm config/cache、Pi 配置、session、原始日志和 token 均在退出时清理。

这份证据证明 SSH 主机上 Pi CLI 的 provider 协议、session identity 和上下文重放成立；`npx` 仍可能访问 npm registry，所以这里只声明模型端点为 loopback、未触达外部模型。它不证明生产 provider 认证、真实模型推理、工具权限流程或 Tunara UI 的恢复动作。完整脱敏字段见 [SSH Pi loopback resume summary](./raw/m1-agent-tui-2026-07-11/ssh-pi-loopback-resume-summary.json)。

## Tunara 真实应用内验收

安装版 `/Applications/Tunara.app` 1.14.0 中新建临时本地终端，运行同一 `unknown-tui.py` fixture。运行中的 xterm 持久化快照为该会话保留了 CJK、emoji、True Color 序列、高输出完成、waiting、recoverable failure 和 resume marker。

| 动作 | 强证据 | 结果 |
|---|---|---:|
| 左右分屏 | 布局持久化为 horizontal 50/50；fixture 实收 `SIGWINCH`，几何从 `22x82` 变为 `22x40` | 通过 |
| 后台切回 | 切到 Finder 等待后返回，原会话、分屏比例、alternate-screen 所有权与 marker 均保留 | 通过 |
| 终端复制 | “快速选择附近输出”识别 15 个可复制 token，复制已知 token `255` 后应用显示“已复制 255”；该成功态只在 `navigator.clipboard.writeText` resolve 后产生 | 通过 |
| 中断退出 | `Ctrl+C` 后会话显示完成态，alternate screen 移交回 shell，普通 prompt 恢复 | 通过 |
| SSH Codex 分屏 | `de-netcup` Codex 0.144.1 的 alternate-screen snapshot 在 horizontal 50/50 分屏后保留，欢迎区与 ready prompt 完整 | 通过 |
| SSH Codex 后台切回 | 切到 Finder 后返回，Agent session、split 50/50 与 alternate-screen snapshot 均保留 | 通过 |
| SSH Codex 复制粘贴 | 快速选择识别 5 个候选；复制受控 token `144.1` 后应用确认成功，系统粘贴回 Codex 输入框得到完全相同文本；未提交并以 `Ctrl+C` 清空 | 通过 |
| SSH Codex bracketed 多行粘贴 | 安装版 1.14.0 虽显示原生“即将粘贴 2 行”，确认后却把 `TUNARA_SSH_CODEX_LINE_ONE` / `LINE_TWO` 立即提交并进入 Working；已用 Escape 中断。根因是异步原生 sheet 返回时 xterm 读取瞬态关闭的 DECSET 2004，且右键菜单粘贴直接调用 `term.paste` 绕过保护。`6bebf09` 在确认前捕获模式，确认后按 xterm 同等换行规则显式包装 bracketed paste，并统一菜单入口。当前源码 Debug bundle 重测 `TUNARA_SOURCE_CODEX_LINE_ONE` / `LINE_TWO`：两行稳定留在 composer，状态保持“已完成”，等待后未进入 Working，Escape 后清空 | 通过真实失败复现、源码修复、两行预警、远端传输、不自动提交与取消语义 |
| SSH Codex 正常退出 | `de-netcup /root` 中以 read-only sandbox 启动 Codex 0.144.1，官方 `/exit` 交还 `root@de-netcup:~#`；真实 xterm 快照随后记录 `TUNARA_SSH_CODEX_SHELL_OK` | 通过 |
| 本地 Pi 状态语义 | 旧安装版取证证明就绪页脚与 `Running...` 会同时存在；当前源码 Debug bundle 的 32 列窄 pane 还证明页脚会裁切为 `$0.000 (sub) 0.0%/272k (auto)  gp` 且位于输入光标下方。`118a1c5` 让忙碌优先，`5fc3a0e` 读取光标上下有界窗口并识别裁切页脚 | 通过：真实 `加载中 → 就绪 → !sleep 3 运行中 → 就绪` |
| 本地 Pi 首次权限 | 在 repo cwd 启动出现 `Trust project folder?`；未选择持久 Trust，而是 `Do not trust (this session only)`，随后 Pi 明确提示项目 `.pi` 资源与 packages 被忽略 | 通过，安全拒绝路径可继续进入就绪态 |
| SSH 分屏 transport/cwd | 独立 Debug bundle 从 `de-netcup /root` 会话创建 horizontal 50/50 新 pane；新 pane 经“正在协商 SSH”后成为第二条 `root@de-netcup: ~`、`远程 SSH 会话 /root` | 通过，未降级到本机 cwd |
| 本地 Pi 分屏与后台 | Pi 与 SSH Codex 保持 horizontal 50/50；切到 Finder 后返回，Pi session、输入焦点目标与 split 均保留 | 通过 |
| 本地 Pi 复制粘贴 | 快速选择识别 8 个候选；复制受控版本 token `79.4` 后应用显示“已复制 79.4”，系统粘贴回 Pi 输入框得到完全相同文本；未提交并以 `Ctrl+C` 清空 | 通过 |
| 本地 Pi bracketed 多行粘贴 | `/tmp` 中用 `pi --no-session` 启动的 Pi 0.79.4 主输入区触发 Tunara 原生“即将粘贴 2 行”确认。确认后持久 SerializeAddon 快照在 Pi 输入区上下边界内同时记录 `TUNARA_LOCAL_PI_LINE_ONE` 与 `TUNARA_LOCAL_PI_LINE_TWO`，下方仍为 canonical `/private/tmp` 和 `$0.000 (sub) 0.0%/272k (auto) gpt-5.5`；后台切回后输入仍在，未触发 provider。`Ctrl+C` 后下一份快照两 marker 均消失，Pi 0.79.4 与 ready footer 保留 | 通过本地预警、双行可见、后台保留、不提交与取消语义 |
| 本地 Pi 正常退出 | Pi 0.79.4 ready prompt 明确显示 `ctrl+c/ctrl+d clear/exit`；在空输入发送 `Ctrl+D` 后 alternate screen 交还普通 zsh，真实 xterm 快照记录 `TUNARA_LOCAL_PI_SHELL_OK` | 通过 |
| 本地 Claude 分屏与后台 | Claude Code 2.1.178 以 `--permission-mode plan` 在右 pane 启动，与 SSH Codex 保持 horizontal 50/50；切到 Finder 后返回，两 TUI、split 与输入目标均保留 | 通过 |
| 本地 Claude 复制粘贴 | 快速选择识别 5 个候选；复制受控版本 token `1.178` 后应用显示“已复制 1.178”，系统粘贴回 Claude 输入框完全一致；未提交并以 `Ctrl+C` 清空 | 通过 |
| 本地 Claude bracketed 多行粘贴与状态 | 当前源码 Debug bundle 的 `/private/tmp` Claude Code plan-mode 主输入区准确触发原生“即将粘贴 2 行”；`TUNARA_LOCAL_CLAUDE_FIXED_LINE_ONE` / `LINE_TWO` 同时留在输入框，未产生对话输出。首次复验暴露粘贴后永久显示“运行中”：直接回放证明 input scanner 把 bracketed envelope 内部 `\r` 误判为 Enter submission。`12cc61b` 显式跨 data event 跟踪 bracketed-paste 状态，包装内换行只进入 buffer；重启后同路径复验侧栏保持纯 `Claude Code`、无 running timer，plan mode 保持 | 通过两行预警、精确输入、不自动提交，并修复 false busy |
| 本地 Claude 正常退出 | 官方 `/exit` 后会话进入“可恢复”，alternate-screen 交还普通 shell；随后 shell 实际执行 `printf` 并输出 `TUNARA_CLAUDE_SHELL_OK` | 通过 |
| SSH Aider 账号与失败边界 | `de-netcup /root` 上 Aider 0.86.2 首次询问 OpenRouter 登录/建号时明确选择 `n`，后续打开文档也拒绝；改用固定 `openai/gpt-4o-mini` 后因远端无 `OPENAI_API_KEY` 显示 `AuthenticationError`，随后 TUI prompt 恢复 | 通过安全边界；不计 provider 成功 |
| SSH Aider 分屏与后台 | Aider 与本地 shell 保持 horizontal 50/50；切到 Finder 后返回，远端 TUI、split 与输入目标均保留 | 通过 |
| SSH Aider 复制粘贴 | 快速选择识别 6 个候选；复制受控版本 token `86.2` 并精确粘贴回 Aider 输入；未提交给 provider，以 `Ctrl+C` 清空 | 通过 |
| SSH Aider bracketed 多行粘贴 | 在 `de-netcup /tmp` 用 `--no-show-model-warnings` 进入 Aider 0.86.2 主 prompt，系统剪贴板放入两行受控 marker；Tunara 原生安全确认准确显示“即将粘贴 2 行”。确认后 `TUNARA_SSH_AIDER_LINE_ONE` 与 `TUNARA_SSH_AIDER_LINE_TWO` 均经 SSH 精确显示在 Agent 输入区，未自动提交，`Ctrl+C` 后回到空 prompt。首次在启动文档询问处的误落点已取消并恢复远端 shell，不计主 prompt 通过 | 通过远端行数预警、两行传输、不自动提交与取消语义 |
| SSH Aider 正常退出 | 官方 `/exit` 交还远端 Bash；随后实际执行 `printf` 并观察到 `TUNARA_SSH_AIDER_SHELL_OK` | 通过 |
| SSH Bash Agent 身份 | 安装版复现裸 OSC 133 `C` 让命令块混入 `root@de-netcup:~#`，导致 Aider 未被识别并沿用旧 Codex 可恢复身份；`ca79bf3` 改为优先使用真实提交输入，OSC 自带 payload 仍优先，终端缓冲仅兜底 | 源码 123 项定向、423 项全量、typecheck、lint、build 通过；新 bundle 实机复验待完成 |
| SSH OpenCode 版本边界 | 交互式 Bash 的 `opencode` 实际解析为 `/root/.opencode/bin/opencode` 1.1.56，而 `/usr/local/bin/opencode` 为 1.17.18；旧核心加载 `oh-my-openagent@latest` 4.16.3 后在 `src/plugin/index.ts:90` 报 `fn3 is not a function`。warm cache、隔离 cache 与隔离 HOME 对照均证明 1.17.18 可稳定进入 TUI | 通过根因定位；属于远端 PATH/插件版本漂移，不计 Tunara 缺陷 |
| SSH OpenCode 分屏与后台 | 用明确路径 `/usr/local/bin/opencode --pure` 启动 1.17.18，alternate-screen TUI 在 horizontal 50/50 中保持运行；切到 Finder 后返回，远端 TUI、split 与输入目标均保留 | 通过 |
| SSH OpenCode 复制粘贴 | 快速选择识别 4 个候选；复制受控版本 token `1.17` 并精确粘贴回 OpenCode 输入；未提交给 provider，以 `Ctrl+C` 清空 | 通过 |
| SSH OpenCode bracketed 多行粘贴 | `de-netcup /tmp` 的 OpenCode 1.17.18 主 composer 触发 Tunara 原生“即将粘贴 2 行”确认。确认后持久 SerializeAddon 快照在 `┃` composer 边框内相邻两行记录 `TUNARA_SSH_OPENCODE_LINE_ONE` 与 `TUNARA_SSH_OPENCODE_LINE_TWO`，并保留 `/tmp`、`1.17.18`、alternate screen、bracketed/focus/mouse mode；后台切回后输入仍在。未产生提交后对话；`Ctrl+C` 后下一份快照两 marker 均消失，OpenCode TUI 仍运行 | 通过远端预警、双行 composer 可见、后台保留、不提交与取消语义 |
| SSH OpenCode 正常退出 | `/exit` 交还远端 Bash；随后实际执行 `printf` 并观察到 `TUNARA_SSH_OPENCODE_SHELL_OK` | 通过 |
| 本地 OpenCode 状态与分屏 | 本机 OpenCode 1.17.18 以 `opencode --pure` 在右 pane 启动，Tunara 明确识别为 `OpenCode · 运行中`；与 SSH shell 保持 horizontal 50/50 | 通过 |
| 本地 OpenCode 后台与剪贴板 | Finder 后台切回后 TUI、split 与输入目标保留；快速选择识别 3 项，token `1.17` 精确复制粘贴且未提交，以 `Ctrl+C` 清空 | 通过 |
| 本地 OpenCode bracketed 多行粘贴 | `/tmp` 中的 OpenCode 1.17.18 主 composer 触发 Tunara 原生“即将粘贴 2 行”确认。确认后持久 SerializeAddon 快照在深色 `┃` composer 边框内相邻两行记录 `TUNARA_LOCAL_OPENCODE_LINE_ONE` 与 `TUNARA_LOCAL_OPENCODE_LINE_TWO`，并保留 canonical `/private/tmp`、`1.17.18` 与 TUI modes；后台切回后输入仍在。未产生提交后对话；`Ctrl+C` 后下一份快照两 marker 均消失，界面仍为 `OpenCode · 运行中` | 通过本地预警、双行 composer 可见、后台保留、不提交与取消语义 |
| 本地 OpenCode 正常退出 | `/exit` 后普通 zsh 恢复，实际输出 `TUNARA_LOCAL_OPENCODE_SHELL_OK` | 通过 |
| 跨 Agent 恢复身份 | 安装版在同一 pane 先退出 Claude、再运行并退出 OpenCode 后，界面错误显示 `OpenCode 可恢复`，但持久化 `agentResume` 仍是旧 Claude UUID，恢复按钮未启动 OpenCode。`a956004` 在 Agent 身份切换时清除不匹配 resume，并让历史脏快照按真正 resume agent 显示 | 源码 115 项定向、424 项全量、typecheck、lint、build 通过；新 bundle 实机复验待完成 |
| 本地 Codex 权限、分屏与后台 | Codex 0.144.1 以 `codex --sandbox read-only` 在右 pane 启动，与 SSH shell 保持 horizontal 50/50；首次信任提示进入 review 后明确选择 `Continue without trusting (hooks won't run)`，未授予持久信任且仍进入 ready prompt；Finder 后台切回后 session、split 与输入目标保留 | 通过安全拒绝路径；不宣称本轮上下文 resume |
| 本地 Codex 命令菜单语义 | 真实 xterm 持久快照确认输入 `/` 打开命令菜单并列出 `/model`、`/fast`、`/ide`、`/permissions` 等项；继续输入 `/perm` 后只剩 `/permissions`，`Ctrl+C` 清空菜单并恢复空 prompt。方向选择与多行编辑本轮未宣称通过 | 通过 `/` 打开、过滤与取消语义 |
| 本地 Codex 完整输入语义 | 新增 tmux 屏幕 verifier 处理 Codex 的 Kitty keyboard protocol。启动时出现 5 个 hooks review，明确选择 `Continue without trusting (hooks won't run)`；随后 `/` 菜单与 `/perm → /permissions` 过滤、Ctrl+C 菜单取消、Ctrl+R `reverse-i-search` 打开与 Esc 取消、bracketed 双行 marker 相邻显示与 Ctrl+C 清空、空 prompt Ctrl+D 正常退出全部通过。运行参数固定 `--sandbox read-only -a never -C /private/tmp`，没有模型 prompt 或 hook 信任；raw tmux 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/local-codex-semantics-summary.json) | 通过菜单、过滤、历史、多行、取消、安全拒绝与正常退出 |
| SSH Codex 完整输入语义 | 同一 tmux verifier 在本机包裹 `ssh -tt de-netcup`，远端无需安装 tmux。首次 `/` 曾被 MCP 启动重绘吞掉，verifier 因此增加“composer 可见、Booting/Starting MCP 消失”门和一次安全菜单重试；最终 `/` 菜单、`/perm → /permissions`、菜单取消、reverse search、双行编辑、取消清空和 Ctrl+D 退出全部通过。远端同样固定 read-only/never，未提交模型请求；raw 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-codex-semantics-summary.json) | 通过远端菜单、过滤、历史、多行、取消与正常退出，并覆盖异步 MCP 启动时序 |
| 本地 Pi 完整输入语义 | 专用 tmux verifier 在 `/private/tmp` 启动 Pi 0.79.4 `--no-session`；`/` 展示 32 个命令，`/mod` 只保留 model/scoped-models，Ctrl+C 取消；以 `!!printf TUNARA_PI_HISTORY_SEED` 创建真实 session history，该命令的输出按 Pi 语义不进入模型上下文，空 editor 的 Up 恢复完整命令、Down 回到空草稿；bracketed 双行 marker 相邻可见并由 Ctrl+C 清空，空 prompt Ctrl+D 正常退出。没有提交模型 prompt，raw 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/local-pi-semantics-summary.json) | 通过菜单、过滤、Up/Down 历史、多行、取消与正常退出 |
| SSH Pi 完整输入语义 | 同一 verifier 通过 `ssh -tt de-netcup` 启动固定 Pi 0.79.4；无模型环境仍完整通过 `/` 菜单、`/mod` 过滤、取消、`!!printf` 安全历史 seed、Up/Down 历史、多行编辑、Ctrl+C 清空和 Ctrl+D 退出。远端只执行本地 `printf`，没有 provider 请求；raw 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-pi-semantics-summary.json) | 通过远端菜单、过滤、历史、多行、取消与正常退出 |
| 本地 OpenCode 完整输入语义 | 专用 tmux verifier 在隔离 HOME 中启动 OpenCode 1.17.18 `--pure`，配置只指向本机临时 HTTP 401 stub，关闭 write/bash 工具；`/` 菜单、`/mo` 过滤、Esc 取消、bracketed 双行 marker 与 Ctrl+C 清空全部通过。受控 history marker 只到达 `127.0.0.1` 并稳定得到 Unauthorized，随后 Up 在 composer 恢复 marker、Ctrl+C 清空，`/exit` 正常退出。没有外部模型或工具可达，runtime 与 raw 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/local-opencode-semantics-summary.json) | 通过菜单、过滤、多行、失败后真实历史、取消与正常退出 |
| SSH OpenCode 完整输入语义 | 同一 helper 临时复制到 `de-netcup /tmp`，隔离远端 HOME 并让 1.17.18 只访问远端 loopback 401 stub；verifier 等待 `/mo` 真正渲染且 `/agents` 消失，避免 SSH 重绘时把旧菜单误计为过滤成功。菜单、过滤、取消、多行、Unauthorized 失败、Up 历史恢复、清空和 `/exit` 均通过；helper、runtime 与 raw 快照全部删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-opencode-semantics-summary.json) | 通过远端完整语义并覆盖过滤重绘时序 |
| 本地 Aider 完整输入语义 | 隔离 helper 用 uvx 固定 Aider 0.86.2，所有 input/chat/LLM history 写入临时 runtime，并关闭 Git、自动提交、更新检查、analytics 和浏览器；`/` 菜单、`/sett → /settings` 过滤与 Ctrl+C 取消通过。执行纯本地 `/settings` 后，Ctrl+Up 恢复命令、Ctrl+Down 回到空 prompt；bracketed 双行 marker 与 Ctrl+C 清空、`/exit` 正常退出均通过。未提交模型 prompt，runtime 与 raw 快照自动删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/local-aider-semantics-summary.json) | 通过菜单、过滤、本地命令历史、多行、取消与正常退出 |
| SSH Aider 完整输入语义 | 同一 helper 临时复制到 `de-netcup /tmp`，使用固定 `/usr/local/bin/aider` 0.86.2 和远端隔离 history；菜单、`/sett` 过滤、取消、本地 `/settings`、Ctrl+Up/Down 历史、双行编辑、清空和 `/exit` 全部通过。未触发 provider，helper、runtime 与 raw 快照全部删除，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-aider-semantics-summary.json) | 通过远端完整输入语义且无模型/Git/浏览器副作用 |
| 本地 Codex 复制粘贴与退出 | 快速选择识别 4 项，受控 token `5` 精确复制粘贴且未提交，以 `Ctrl+C` 清空；随后官方 `/exit` 交还普通 zsh，真实终端快照记录 `TUNARA_LOCAL_CODEX_MENU_SHELL_OK` | 通过 |
| 本地 Codex bracketed 多行粘贴 | 当前源码 Debug bundle 在 `/private/tmp` Codex 0.144.1 中通过 hooks review 并明确选择 `Continue without trusting`。原生确认准确显示 2 行，`TUNARA_LOCAL_CODEX_SAFE_LINE_ONE` / `LINE_TWO` 稳定留在 composer，顶栏保持“已完成”，等待后未进入 Working。取证后的清理误用了 Escape（Codex 语义是编辑上一条而非清空），导致后续 `/exit` 被人工追加并提交；仅含受控标记、无敏感数据，随后用 `/stop` 与 `/exit` 恢复 shell。该操作错误不计自动粘贴失败，后续统一用 Ctrl+C 清空 | 通过本地预警、双行可见和确认后不自动提交；如实记录操作边界 |
| 恢复按钮立即执行 | 安装版“恢复”只把命令放入不可见 pending input，下一条手工命令会与其拼接；`9a69d97` 让顶栏和全局栏恢复动作都立即提交 | 当前源码 Debug bundle 点击 Claude Code 恢复卡后无需回车，立即进入“启动中/加载中”并生成 `claude --resume` 命令块，通过 |
| 精确 session id 的 Agent 命令隔离 | 安装版在记录 Codex 精确 session id 后，持久化 `agentResume.agent` 为 Codex，但 source command 错沿用 `claude --permission-mode plan`；`9202a37` 只允许同 Agent 的旧命令，且只接受与当前 Agent 探测结果一致的 `lastCommand` | 源码 425 项全量、typecheck、lint、build 通过；新 bundle 实机复验待完成 |
| 本地 Aider 安全边界、剪贴板与退出 | 在 `/tmp` 以 `uvx --from aider-chat aider --no-git` 启动，依赖安装期间保持 horizontal 50/50；无 key 时明确拒绝 OpenRouter 登录/建号和打开文档，未进入 provider 调用。当前源码 bundle 用固定 `openai/gpt-4o-mini` 进入 Aider 0.86.2 prompt，快速选择 hint 复制 `86.2`、系统粘贴回 prompt 精确一致，未提交并以 `Ctrl+C` 清空；`/exit` 恢复 `/tmp` 普通终端。Finder 后台往返和既有 shell marker `TUNARA_LOCAL_AIDER_SHELL_OK` 均保留 | 通过安全拒绝、后台、剪贴板与 shell 恢复；不宣称 resume |
| 本地 Aider bracketed 多行粘贴 | 系统剪贴板放入受控的两行 marker 后在真实 Aider prompt 执行粘贴；Tunara 原生安全确认准确显示“即将粘贴 2 行”。用户确认后 `TUNARA_AIDER_LINE_ONE` 与 `TUNARA_AIDER_LINE_TWO` 均在 Agent 输入区可见，没有向 provider 自动提交；随后 `Ctrl+C` 清空输入 | 通过行数预警、确认、两行传输、不自动提交与取消语义 |
| 快速选择 overlay 焦点 | 安装版从命令面板打开快速选择后，辅助树焦点仍在 xterm input，Escape 与提示键穿透进 Aider prompt，实测产生未提交的 `a'a`。根因是 generic div 的 `autoFocus` 不可靠，且前一个 focus trap 卸载会无条件恢复旧焦点 | 当前源码在 mount effect 显式聚焦 dialog，focus trap 只在焦点仍属于关闭 overlay 或 document root 时恢复。Debug bundle 中 dialog 成为焦点，hint `s` 复制而不写入终端，Escape 关闭后焦点回到 Terminal input，通过 |
| compound/uvx Agent 身份 | 安装版只看第一个 token，未把 `cd /tmp && uvx --from aider-chat aider --no-git` 识别为 Aider，并把交互回答 `n` 错作 session title；`d8d6a2b` 增加引号感知的 shell segment/word 解析、路径/`env`/`exec` 包装与 `uvx --from` 入口识别，同时保持 `echo aider`、引号内 Agent 名称不误报 | 当前源码 Debug bundle 用 5 秒确定性 `/tmp` uvx fixture 真实显示 `Aider · 运行中`，退出后恢复 `/tmp` 终端，通过 |
| SSH Pi 安全边界、后台、剪贴板与退出 | `de-netcup /root` 通过固定 `npx` 包启动 Pi 0.79.4，horizontal 50/50 保持；TUI 明确显示 `No models available` 与 `/login` 指引，不伪报 provider 成功。Finder 后台往返保持 session、split 与输入目标；快速选择复制受控 token `79.4`，系统粘贴回空 prompt 后辅助树与画面均精确显示，未提交并以 `Ctrl+C` 清空。空 prompt 发送 `Ctrl+D` 后恢复 `root@de-netcup:~#`，真实快照记录 `TUNARA_SSH_PI_SHELL_OK` | 通过启动、失败边界、分屏、后台、剪贴板与退出；不宣称 resume |
| SSH Pi bracketed 多行粘贴 | `de-netcup /tmp` 的 Pi 0.79.4 无模型 ready prompt 触发 Tunara 原生“即将粘贴 2 行”确认。确认后持久 SerializeAddon 快照在 Pi 输入区上下边界内同时记录 `TUNARA_SSH_PI_LINE_ONE` 与 `TUNARA_SSH_PI_LINE_TWO`，下方仍是 `/tmp` 和 `0.0%/0 (auto) unknown`；后台切回后输入仍在，未触发 provider。`Ctrl+C` 后画面恢复空输入，下一份快照两 marker 均消失，Pi 版本与无模型 footer 保留 | 通过远端预警、双行可见、后台保留、不提交与取消语义 |
| SSH Pi 确定性 TUI 状态恢复 | `c455d83` 扩展零模型语义 harness，以 `!!sleep 2` 产生真实 shell busy，不进入模型上下文；脱敏汇总同时要求 `Running... (escape/ctrl+c to cancel)` 出现、消失并恢复 `(auto) ... unknown` footer。随后继续完成菜单、历史、双行取消与正常退出，12/12 检查通过，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-pi-semantics-summary.json) | 通过 Pi TUI `ready → running → ready`，无 provider 消耗 |
| SSH Pi 当前极窄 bundle 几何 | 隔离 `dev.tunara.app.dev` 在 673×506 恢复 SSH Pi + 本地终端 horizontal 50/50，真实后端打开 `de-netcup`；持久 snapshot 记录 56×39，序列化内容未触发容量裁剪，并保留 Pi 0.79.4、无模型警告、ready footer 与 Pi 退出后的 Bash prompt。ScreenshotDaemon 能列出 673×506 窗口，但 window capture 仍只返回壁纸，Inspector 也未在本次可审阅画面中展开，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-pi-narrow-layout-summary.json) | SSH 运行与 snapshot 几何已记录；Inspector 同屏视觉门未通过 |
| SSH Pi 产品级精确恢复 | 当前 Tuna Debug bundle 在真实 `de-netcup` pane 启动 Pi 0.79.4 与 loopback-only 认证 provider；首轮 marker 后正常退出，Pi 恢复卡显示捕获的 `/tmp/tunara-pi-ui-e2e`。点击按钮无需回车，在同一 pane 自动提交并保持 SSH provenance、cwd、固定 session ID、session-dir、provider/model、能力收紧和离线姿态；恢复轮得到 `TUNARA_PI_RESUME_OK`。provider 记录 4 次请求、2 主/2 辅助，并证明 user context 与 assistant marker 重放，见 [脱敏汇总](./raw/m1-agent-tui-2026-07-11/ssh-pi-product-resume-summary.json) | 产品 UI、状态识别、按钮、自动提交、同 pane、精确身份与上下文重放通过；生产 provider 仍待验证 |
| SSH Claude 首次权限、恢复、剪贴板、多行与退出 | 既有 `/root`、`/tmp` 两次 `No, exit` 证明安全拒绝与后台保留。当前源码又从持久化 split 冷启动：后端 `ssh opened id=2` 后前端 open Promise 以 `disposed=false` 返回；受控 HMR 连续完成 SSH `2→4→6→8` 和 local `1→3→5→7` PTY 重建，辅助树有两个独立 `Terminal input`、无连接遮罩，Tunara pane 写入的 `TUNARA_SSH_SHELL_BASELINE` 可由独立 SSH 读回。首轮多行取证实际停在自定义 API key 选择页，未计通过；重测在隔离 `/tmp/tunara-claude-smoke` 选择推荐的“不使用环境 key”后，持久 SerializeAddon snapshot 明确显示 ready composer、plan mode 与 Missing API key。快速选择识别 4 项，第一项为 `4.5`；按 hint `a` 后系统剪贴板读回 `4.5`，粘贴回 composer 的 snapshot 为 `❯ 4.5`，未提交并以 Ctrl+C 清空。原生预警准确显示 2 行及 Cancel/OK，确认后 `TUNARA_SSH_CLAUDE_REAL_LINE_ONE` / `LINE_TWO` 在 composer 内相邻可见，无对话或 provider 提交；第二次 Ctrl+C 后两 marker 均消失且 ready footer 保留。Claude 随后明示 `Press Ctrl-C again to exit`，再次双 Ctrl+C 交还远端 Bash；shell marker `TUNARA_SSH_CLAUDE_REAL_SHELL_OK` 由独立 SSH 读回，隔离目录清理 | 通过恢复、远端 TTY、普通 token 精确回环、行数预警、双行可见、不自动提交、取消清空与正常退出；provider/resume 仍不宣称通过 |
| SSH Claude 具体键位语义 | 新增分段 verifier，在已有 true 信任记录的空临时目录和 plan mode 中逐段取证：三次 Shift+Tab 依次出现默认 `? for shortcuts`、`accept edits on`、`plan mode on`；`/` 菜单展示 `/add-dir` 与 `/agents`，Down 将高亮移到 `/agents`，Up 返回 `/add-dir`，Esc 后菜单消失且 plan footer 恢复；Ctrl+R 显示 `search`/`prompts:`，Esc 后搜索关闭；bracketed 双行 marker 相邻可见，Ctrl+C 后两者消失并出现空 prompt 的二次退出提示；最后 `/exit` 正常关闭，状态码 0。全程未提交模型请求，raw 分段日志和临时目录已删除，见 [脱敏语义汇总](./raw/m1-agent-tui-2026-07-11/ssh-claude-semantics-summary.json) | 通过模式循环、菜单打开、上下选择、菜单取消、历史搜索打开/取消、多行编辑、取消清空与正常退出 |
| 本地 Claude 具体键位语义 | 同一分段 verifier 在已信任的 `/private/tmp` 和 plan mode 中运行；本地新版 Claude 的模式环包含 `auto mode` 与 `accept edits`，并能回到 plan mode。`/` 菜单展示本机已安装的 `/think`、`/check` 等 skills；输入 `t` 后菜单只保留以 `t` 开头的候选，Backspace 恢复原候选，Esc 关闭。Ctrl+R 打开 `Search prompts`，Esc 恢复 composer；双行 marker 相邻可见，Ctrl+C 清空，`/exit` 状态码 0。新版菜单方向键不产生重绘，因此不宣称上下高亮；以真实过滤与恢复证明选择变化。raw 分段日志自动删除，见 [脱敏语义汇总](./raw/m1-agent-tui-2026-07-11/local-claude-semantics-summary.json) | 通过模式循环、菜单过滤/恢复、菜单取消、历史搜索打开/取消、多行编辑、取消清空与正常退出 |
| Terminal Fast Refresh 生命周期 | 旧实现的 `initRef` 在 effect cleanup 后仍保持 `true`；真实 HMR 日志只有 `pty closed id=2/1`，之后没有任何 open，留下只读快照、连接遮罩与不可用输入。cleanup 现在先把 latch 复位，再关闭旧 PTY | 真实 HMR 两轮均自动重建本地与 SSH PTY；冷启动对照正常，定向回归测试锁定 cleanup 顺序 |
| 异步粘贴确认生命周期 | 原生 sheet 可跨越 HMR 或会话关闭；Fast Refresh 中旧 xterm 已 dispose 但 DOM 仍可能连接，`element.isConnected` 不是充分存活证据 | DOM paste 注册器 dispose 后令在途确认失效；菜单入口确认返回时要求当前终端仍等于捕获实例。17 项定向、444 项 Node 全量、typecheck、lint、build 通过 |
| npx Pi Agent 身份与无模型 ready | 安装版未把 scoped、带版本的 `@earendil-works/pi-coding-agent@0.79.4` 映射为 Pi，外层仅显示普通“运行”；`c5d4497` 只读取 npx 首个包位并显式映射官方包，`npx left-pad pi` 负例不误报。当前源码 bundle 已真实显示 Pi；首次复验因无模型 footer 省略 `$cost (sub)` 而停在 `Pi · 加载中 · 14s`，本轮允许该可选段并保留 anchored context/mode 约束 | 定向回归 4/4 与增量 Debug bundle 通过；同一 SSH 无模型画面复验后侧栏为 Pi idle/ready，全局“正在跑”消失 |
| Titlebar tab/关闭语义 | 安装版辅助技术树把“选择会话”和“关闭会话”压成一个按钮；尝试切换 Pi tab 实际进入“再次点击确认关闭”，未二次确认且会话保持运行。`2c7350f` 将容器改为具名 tablist，选择使用独立 tab，关闭使用独立 button，并让安静隐藏的关闭按钮在键盘 focus 时可见 | 当前源码 Debug bundle 的辅助树为具名“终端会话”tab group，每个 tab 后有独立关闭按钮；点击 `root@de-netcup` 只改变 selected 状态，截图与行为均通过 |
| 运行时长不显示负值 | 当前源码恢复 Claude 时首次观察到持久化未来时间戳令侧栏显示 `-207s`；`11d817a` 将格式化提取为纯函数并把负差值钳制到零 | 重建 Debug bundle 同一路径显示 `0s`；2 项定向、429 项全量、typecheck、lint、build 通过 |

自动化截图对非当前 macOS Space 里的 GPU/WebGL 合成层返回了灰面、黑块或桌面壁纸，与同一时刻的 xterm 快照和应用状态矛盾。因此不把该截图当成产品白屏证据，也不为截图工具限制修改终端代码。脱敏机器可读证据见 app runtime summary。

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
| `Esc` / Tab / Shift+Tab / 四方向键 | 通过 | 通过 |
| `Ctrl+R` / bracketed 多行 / `Ctrl+C` | 通过 | 通过 |
| 中断退出并恢复终端模式 | 通过 | 通过 |

## 剩余完成门

### 已收敛的通用门

- 未知 TUI 以及本地/SSH Claude、Codex、Pi、OpenCode、Aider 均已在 Tunara 内通过真实分屏存活；SSH 新 pane 还证明 transport/cwd 不降级。本地 Pi 的 32 列窄 pane 已通过状态识别，SSH Pi 当前隔离 bundle 又补充 673×506、56×39 snapshot，零模型 harness 补充 Pi TUI `ready → running → ready`；侧栏与 Inspector 同时展开的可审阅像素证据仍属下方待办。
- 10 个真实 Agent 格均已通过窗口后台切回后的 session、split 与输入目标保留；多行输入跨后台保留也已在 Pi、OpenCode、Aider 等代表性本地/SSH TUI 中取得持久 snapshot。
- 10 格均已完成受控 token 的系统剪贴板复制→普通粘贴精确回环且未提交，并通过原生两行预警、确认、精确输入、不自动提交和取消边界。
- 10 格均已用各自正常退出或安全拒绝路径恢复普通 shell；所有正常退出格都有真实 shell marker，SSH Claude 当前 bundle 的 marker 还由独立 SSH 读回。
- 此前“后端已开但 pane 永久重连”已定位为 Fast Refresh 的 `initRef` 单向锁并修复，不再列作 SSH IPC 阻塞。
- app shell 已建立终端优先的定量几何门：single/vertical 保留至少 480px，horizontal 保留两个 280px pane 与 5px handle；空间不足时 Inspector 先转非模态抽屉，再让 sidebar 转抽屉，不再使用 720/900 两个与实际面板宽度、split 无关的固定断点。辅助面板的 dock 空间随 viewport 逐像素预留，因此在 single 的 1072px、horizontal 的 1157px 真正模式切换点，窗口变宽也不会让终端反向缩窄。表驱动测试覆盖 240、576、640、719、899、900、1000、1200px、隐藏面板、最大保存宽度及两个真实切换边界。Inspector 的四 tab 已独立横向滚动，workspace 来源只在有内容时显示于摘要行，不再让来源标签与关闭按钮争抢导航宽度。实现前的 Debug baseline 已在 673×506 恢复 local+SSH horizontal split 并记录本地 PTY `38×23`；当前隔离 bundle 的 SSH Pi pane snapshot 记录 `56×39`，序列化内容未触发容量裁剪，但 ScreenshotDaemon 仍只返回壁纸，因此逐 Agent 像素级视觉门保持未完成。

### 真实剩余门

以下每项仍需本地和 SSH 的逐 Agent 证据，不能用未知 fixture 或单次启动替代：

- 本地 Claude 当前组织策略下无法出现人工确认；仍需在策略允许的环境验证真实确认。Pi/OpenCode/Aider 各格已有拒绝持久信任、禁用工具/扩展、账号或凭据失败等安全边界，但尚未覆盖所有“请求工具权限 → 允许/拒绝 → 回到 TUI”的交互。
- 10 类按键的传输探针已在未知 TUI 本地/SSH 和 10/10 真实 Agent 格完整发送；本地与 SSH Claude、Codex、Pi、OpenCode、Aider 共 10/10 格均完成各自真实菜单选择/过滤、历史、双行编辑、取消和正常退出语义。
- 真实工具调用、高输出、等待确认、完成和失败尚未覆盖 10 格；当前强证据集中在本地 Claude、本地/SSH Codex 与 SSH Aider，其余环境受 key、凭据或 timeout 阻断。
- 生产 provider 恢复后的 SSH Claude、SSH Pi、本地/SSH OpenCode 与本地/SSH Aider resume；其中 SSH Pi 已通过受控 loopback provider 的协议/session 与 Tunara 产品 UI 按钮端到端上下文重放，但真实外部 provider 仍未验证。本地 Claude、本地 Codex、本地 Pi、SSH Codex 已用明确会话身份和上下文 token 通过。
- 通用 app shell 最小几何已由定量不变量覆盖；仍需逐 Agent 在当前实现下补齐状态栏、composer、权限/选择界面的真实可读性证据。ScreenshotDaemon 当前健康且已有屏幕录制权限，但对 673×506 Tunara 窗口的有界捕获只得到桌面背景，唯一一次 `activate` 尝试又卡住并已中止，说明阻塞已从权限转为原生窗口的 Space/层级自动化；不能用旧 baseline 的窗口尺寸和 PTY cols 代替当前逐 Agent 视觉截图。

涉及外部账号或 provider 的失败必须记录为环境阻塞，不能把 CLI 启动画面当作模型调用成功。
