# M1 Agent / TUI 兼容性基线（2026-07-11）

## 结论

在固定 commit `ba9272498b473abbb1dcfb10aec9e72c4e93de10` 上，Claude Code、Codex、Pi、OpenCode、Aider 的本地 TTY 启动与 resize 均通过；真实 `de-netcup` SSH 上同样 5/5 通过。远端 Aider 固定安装在独立 `/opt/tunara-agent-tools/aider-0.86.2` venv，入口为 `/usr/local/bin/aider`，不污染远端项目依赖。

一个不受 Tunara hook 支持的确定性未知 TUI 在本地和 SSH 均完整通过：alternate screen 进入/恢复、bracketed paste、focus reporting、mouse tracking、True Color、CJK、emoji、256 行高输出、waiting、failure、resume、`40x120` resize 和中断退出后的模式恢复。

这证明了底层 PTY/SSH TTY 不依赖 Agent 品牌或私有 stdout 布局。交互探针依次发送 `Esc`、Tab、Shift+Tab、四个方向键、`Ctrl+R`、未提交的 bracketed 多行文本和 `Ctrl+C`：9/10 真实 Agent 格收到了完整 10 类探针，7/10 能从绘制字节中观察到两行 marker，6/10 在 fallback 中断前完成 `/exit`、EOF 或 provider 失败后的自然退出。SSH Claude 在第 6 类按键后即因 provider 失败退出，因此未伪报为完整输入传输。

provider 快照层有 4/10 完成真实响应：本地 Claude、本地 Codex、SSH Codex、SSH Aider；其中本地 Claude、本地 Codex、SSH Codex 有结构化 tool event 和完成 marker。后续 session 层已覆盖 10/10 本地/SSH Agent 格，其中本地 Claude、本地 Codex、本地 Pi、SSH Codex 完成真实上下文 resume；本地 Pi 用固定 UUID 产生 18 个 JSON event，first/resume marker 均命中，证明 provider 状态已较早期“缺 key”快照发生漂移。本地/SSH Aider 的显式 history 身份已落盘，但当前 key 无法认证；SSH Claude 固定 UUID 身份已落盘，但两轮均是 402；OpenCode 两端均确认进入同一专用 session，但本地 timeout、SSH 凭据错误；SSH Pi 在创建 session 前缺 key。安装版 Tunara 1.14.0 中的未知 TUI 还完成了真实分屏 resize、后台切回、快速复制和中断后 shell 恢复。完整 GOAL 仍要求逐 Agent 本地/SSH 交互证据，因此 M1 状态保持未完成。

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
| 脱敏摘要 | [TTY summary](./raw/m1-agent-tui-2026-07-11/result-summary.json) · [provider summary](./raw/m1-agent-tui-2026-07-11/provider-summary.json) · [session summary](./raw/m1-agent-tui-2026-07-11/session-summary.json) · [app runtime summary](./raw/m1-agent-tui-2026-07-11/app-runtime-summary.json) |

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
| SSH | Pi | 禁用所有工具与项目扩展 | 阻塞：固定 `npx` 0.79.4 在创建 session 前返回缺 key |
| SSH | Claude Code | `dontAsk` 且不请求工具 | 阻塞：固定 UUID 身份已确认，两轮共 2 个 provider 402 JSON event |
| 本地 | Aider | 非交互 `--message`，禁用 Git/自动提交 | 阻塞：隔离 uvx 的 history 身份已确认，当前 provider key 无法认证 |

Claude 的探针文件在运行后清理。这里的“组织策略自动允许”是环境事实，不是 waiting-for-human 通过；不能为了填满矩阵而把自动执行伪装成权限提示。Codex trust smoke 不选择“继续”，由中断退出；resume 使用另一个已信任的临时目录和 read-only sandbox。

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
| SSH Codex 正常退出 | `de-netcup /root` 中以 read-only sandbox 启动 Codex 0.144.1，官方 `/exit` 交还 `root@de-netcup:~#`；真实 xterm 快照随后记录 `TUNARA_SSH_CODEX_SHELL_OK` | 通过 |
| 本地 Pi 状态语义 | 旧安装版取证证明就绪页脚与 `Running...` 会同时存在；当前源码 Debug bundle 的 32 列窄 pane 还证明页脚会裁切为 `$0.000 (sub) 0.0%/272k (auto)  gp` 且位于输入光标下方。`118a1c5` 让忙碌优先，`5fc3a0e` 读取光标上下有界窗口并识别裁切页脚 | 通过：真实 `加载中 → 就绪 → !sleep 3 运行中 → 就绪` |
| 本地 Pi 首次权限 | 在 repo cwd 启动出现 `Trust project folder?`；未选择持久 Trust，而是 `Do not trust (this session only)`，随后 Pi 明确提示项目 `.pi` 资源与 packages 被忽略 | 通过，安全拒绝路径可继续进入就绪态 |
| SSH 分屏 transport/cwd | 独立 Debug bundle 从 `de-netcup /root` 会话创建 horizontal 50/50 新 pane；新 pane 经“正在协商 SSH”后成为第二条 `root@de-netcup: ~`、`远程 SSH 会话 /root` | 通过，未降级到本机 cwd |
| 本地 Pi 分屏与后台 | Pi 与 SSH Codex 保持 horizontal 50/50；切到 Finder 后返回，Pi session、输入焦点目标与 split 均保留 | 通过 |
| 本地 Pi 复制粘贴 | 快速选择识别 8 个候选；复制受控版本 token `79.4` 后应用显示“已复制 79.4”，系统粘贴回 Pi 输入框得到完全相同文本；未提交并以 `Ctrl+C` 清空 | 通过 |
| 本地 Pi 正常退出 | Pi 0.79.4 ready prompt 明确显示 `ctrl+c/ctrl+d clear/exit`；在空输入发送 `Ctrl+D` 后 alternate screen 交还普通 zsh，真实 xterm 快照记录 `TUNARA_LOCAL_PI_SHELL_OK` | 通过 |
| 本地 Claude 分屏与后台 | Claude Code 2.1.178 以 `--permission-mode plan` 在右 pane 启动，与 SSH Codex 保持 horizontal 50/50；切到 Finder 后返回，两 TUI、split 与输入目标均保留 | 通过 |
| 本地 Claude 复制粘贴 | 快速选择识别 5 个候选；复制受控版本 token `1.178` 后应用显示“已复制 1.178”，系统粘贴回 Claude 输入框完全一致；未提交并以 `Ctrl+C` 清空 | 通过 |
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
| 本地 OpenCode 正常退出 | `/exit` 后普通 zsh 恢复，实际输出 `TUNARA_LOCAL_OPENCODE_SHELL_OK` | 通过 |
| 跨 Agent 恢复身份 | 安装版在同一 pane 先退出 Claude、再运行并退出 OpenCode 后，界面错误显示 `OpenCode 可恢复`，但持久化 `agentResume` 仍是旧 Claude UUID，恢复按钮未启动 OpenCode。`a956004` 在 Agent 身份切换时清除不匹配 resume，并让历史脏快照按真正 resume agent 显示 | 源码 115 项定向、424 项全量、typecheck、lint、build 通过；新 bundle 实机复验待完成 |
| 本地 Codex 权限、分屏与后台 | Codex 0.144.1 以 `codex --sandbox read-only` 在右 pane 启动，与 SSH shell 保持 horizontal 50/50；首次信任提示进入 review 后明确选择 `Continue without trusting (hooks won't run)`，未授予持久信任且仍进入 ready prompt；Finder 后台切回后 session、split 与输入目标保留 | 通过安全拒绝路径；不宣称本轮上下文 resume |
| 本地 Codex 命令菜单语义 | 真实 xterm 持久快照确认输入 `/` 打开命令菜单并列出 `/model`、`/fast`、`/ide`、`/permissions` 等项；继续输入 `/perm` 后只剩 `/permissions`，`Ctrl+C` 清空菜单并恢复空 prompt。方向选择与多行编辑本轮未宣称通过 | 通过 `/` 打开、过滤与取消语义 |
| 本地 Codex 复制粘贴与退出 | 快速选择识别 4 项，受控 token `5` 精确复制粘贴且未提交，以 `Ctrl+C` 清空；随后官方 `/exit` 交还普通 zsh，真实终端快照记录 `TUNARA_LOCAL_CODEX_MENU_SHELL_OK` | 通过 |
| 恢复按钮立即执行 | 安装版“恢复”只把命令放入不可见 pending input，下一条手工命令会与其拼接；`9a69d97` 让顶栏和全局栏恢复动作都立即提交 | 当前源码 Debug bundle 点击 Claude Code 恢复卡后无需回车，立即进入“启动中/加载中”并生成 `claude --resume` 命令块，通过 |
| 精确 session id 的 Agent 命令隔离 | 安装版在记录 Codex 精确 session id 后，持久化 `agentResume.agent` 为 Codex，但 source command 错沿用 `claude --permission-mode plan`；`9202a37` 只允许同 Agent 的旧命令，且只接受与当前 Agent 探测结果一致的 `lastCommand` | 源码 425 项全量、typecheck、lint、build 通过；新 bundle 实机复验待完成 |
| 本地 Aider 安全边界、剪贴板与退出 | 在 `/tmp` 以 `uvx --from aider-chat aider --no-git` 启动，依赖安装期间保持 horizontal 50/50；无 key 时明确拒绝 OpenRouter 登录/建号和打开文档，未进入 provider 调用。当前源码 bundle 用固定 `openai/gpt-4o-mini` 进入 Aider 0.86.2 prompt，快速选择 hint 复制 `86.2`、系统粘贴回 prompt 精确一致，未提交并以 `Ctrl+C` 清空；`/exit` 恢复 `/tmp` 普通终端。Finder 后台往返和既有 shell marker `TUNARA_LOCAL_AIDER_SHELL_OK` 均保留 | 通过安全拒绝、后台、剪贴板与 shell 恢复；不宣称 resume |
| 本地 Aider bracketed 多行粘贴 | 系统剪贴板放入受控的两行 marker 后在真实 Aider prompt 执行粘贴；Tunara 原生安全确认准确显示“即将粘贴 2 行”。用户确认后 `TUNARA_AIDER_LINE_ONE` 与 `TUNARA_AIDER_LINE_TWO` 均在 Agent 输入区可见，没有向 provider 自动提交；随后 `Ctrl+C` 清空输入 | 通过行数预警、确认、两行传输、不自动提交与取消语义 |
| 快速选择 overlay 焦点 | 安装版从命令面板打开快速选择后，辅助树焦点仍在 xterm input，Escape 与提示键穿透进 Aider prompt，实测产生未提交的 `a'a`。根因是 generic div 的 `autoFocus` 不可靠，且前一个 focus trap 卸载会无条件恢复旧焦点 | 当前源码在 mount effect 显式聚焦 dialog，focus trap 只在焦点仍属于关闭 overlay 或 document root 时恢复。Debug bundle 中 dialog 成为焦点，hint `s` 复制而不写入终端，Escape 关闭后焦点回到 Terminal input，通过 |
| compound/uvx Agent 身份 | 安装版只看第一个 token，未把 `cd /tmp && uvx --from aider-chat aider --no-git` 识别为 Aider，并把交互回答 `n` 错作 session title；`d8d6a2b` 增加引号感知的 shell segment/word 解析、路径/`env`/`exec` 包装与 `uvx --from` 入口识别，同时保持 `echo aider`、引号内 Agent 名称不误报 | 当前源码 Debug bundle 用 5 秒确定性 `/tmp` uvx fixture 真实显示 `Aider · 运行中`，退出后恢复 `/tmp` 终端，通过 |
| SSH Pi 安全边界、后台、剪贴板与退出 | `de-netcup /root` 通过固定 `npx` 包启动 Pi 0.79.4，horizontal 50/50 保持；TUI 明确显示 `No models available` 与 `/login` 指引，不伪报 provider 成功。Finder 后台往返保持 session、split 与输入目标；快速选择复制受控 token `79.4`，系统粘贴回空 prompt 后辅助树与画面均精确显示，未提交并以 `Ctrl+C` 清空。空 prompt 发送 `Ctrl+D` 后恢复 `root@de-netcup:~#`，真实快照记录 `TUNARA_SSH_PI_SHELL_OK` | 通过启动、失败边界、分屏、后台、剪贴板与退出；不宣称 resume |
| SSH Claude 首次权限与后台 | `de-netcup` 在 `/root` 与 `/tmp` 用 `claude --permission-mode plan` 启动，均出现 `Do you trust the files in this folder?`；`/root` 还明确列出 `.claude/settings.local.json` 与 `.claude/settings.json` 的执行授权来源。两次均选择 `No, exit`，未改变远端信任。`/tmp` 提示保持时 Finder 往返后 prompt、horizontal 50/50 与输入目标保留，拒绝后恢复 `root@de-netcup:/tmp` Bash | 通过真实信任边界、安全拒绝、分屏、后台与普通 shell 恢复；不宣称 provider/clipboard/resume |
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

以下每项都必须产生本地和 SSH 的逐 Agent 证据，不能用未知 fixture 或单次启动替代：

- 本地 Claude 当前组织策略下的真实人工确认，以及 Pi/OpenCode/Aider 本地与 SSH OpenCode 的首次权限或等价安全边界；SSH Claude 已在 `/root` 与 `/tmp` 两次观察目录信任提示并安全选择 `No, exit`，Codex 本地目录信任、Pi 本地拒绝持久信任、SSH Pi 缺模型失败边界、SSH Aider 拒绝外部账号创建均已观察。
- 10 类按键的传输探针已在未知 TUI 本地/SSH 全部自证，9/10 真实 Agent 格完成发送；仍需逐 Agent 的语义结果（补全/选择/历史/取消/多行编辑），以及 provider 恢复后重测提前退出的 SSH Claude。
- 真实工具调用、高输出、等待确认、完成和失败。
- provider 恢复后的 SSH Claude、SSH Pi、本地/SSH OpenCode 与 SSH Aider resume；本地 Claude、本地 Codex、本地 Pi、SSH Codex 已用明确会话身份和上下文 token 通过。
- 未知 TUI、SSH Codex、本地 Pi、本地/SSH OpenCode 与 SSH Aider 已通过 Tunara 内实际分屏存活；当前源码 Debug bundle 也已通过 SSH 新 pane transport/cwd 继承与 Pi 窄 pane 状态转换。仍需其余 Agent 的分屏、侧栏/Inspector 展开后的最小几何。
- 未知 TUI、SSH Codex、本地 Pi、本地 Claude、SSH Claude、本地/SSH OpenCode 与本地/SSH Aider 已通过窗口后台切回后的 session 与 split 保留；仍需其余 Agent 证据及后台期间输入流。
- 未知 TUI 已通过可见输出写入确认；本地/SSH Codex、本地 Pi、本地 Claude、本地/SSH OpenCode 与本地/SSH Aider 已完成受控 token 的系统剪贴板复制→普通粘贴精确回环且未提交；本地/SSH Aider 与 SSH OpenCode 还已通过原生两行预警、确认、精确输入、不自动提交和 `Ctrl+C` 取消的 bracketed paste 语义。仍需其余 Agent 复制、普通粘贴与 bracketed paste。
- 本地/SSH Codex、本地/SSH Pi、本地/SSH Claude、本地/SSH OpenCode 与 SSH Aider 已用各自正常退出或安全拒绝路径恢复普通 shell；除本轮 SSH Claude 安全拒绝外的通过格均有真实 shell marker，仍需其他 Agent 退出后的普通 shell 恢复。

涉及外部账号或 provider 的失败必须记录为环境阻塞，不能把 CLI 启动画面当作模型调用成功。
