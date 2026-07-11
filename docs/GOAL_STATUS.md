# Tunara Goal 交付与证据矩阵

本表将 [GOAL.md](./GOAL.md) 的方向拆成可验证增量。状态只依据已合入实现和本轮真实证据更新，不以入口、占位 UI 或计划文档代替完成。

## 当前结论

`M0 Phase 1 真实验收` 已完成，证据见 [M0 已挂载终端性能基线](./benchmarks/m0-terminal-baseline-2026-07-11.md)。当前唯一 Active Milestone 是 `M1 Terminal + SSH 性能与乱码稳定性`，按 [M1 实施规格](./M1_TERMINAL_SSH_PERFORMANCE.md) 执行；M1 未完成前不启动编辑器、Preview、Timeline、Companion 或 Recipe。

| 阶段 | 状态 | 当前证据 | 下一道完成门 |
|---|---|---|---|
| Phase 1 Workspace / Worktree | 已完成 | common git dir 稳定身份、本地/SSH worktree、真实 bundle/窄窗/重启/中文路径、12 个已挂载终端资源与交互基线 | 保持回归；主线进入 M1 性能与乱码稳定性 |
| Phase 2 Markdown / 单文件轻编辑 | 未开始 | 已有只读文件预览与外部编辑器逃生口 | 阅读器、冲突检测、本地安全写、SSH 原子写回完整闭环 |
| Phase 3 Workspace Preview | 未开始 | 终端已有 URL 检测基础能力待盘点 | workspace 绑定、安全 WebView、来源/截图/错误摘要闭环 |
| Phase 4 Agent Attention / Timeline | 部分基础 | 已有 PTY 内 Agent 探测、状态证据、恢复意图、轻量 session timeline、完成提醒与 diff 入口 | 事件 header/payload 分离、Rust append-only 持久层、游标分页、10,000 事件虚拟列表与性能证据 |
| Phase 5 Worktree 生命周期 | 未开始 | Phase 1 只读模型正在建立 | 创建/删除安全检查、恢复扫描、本地与 SSH 一致语义 |
| Phase 6 Mobile Companion | 未开始 | Phase 1 稳定 identity 正在建立；桌面仍是唯一事实源 | 等 Phase 4 事件模型稳定后，先做默认关闭、只读、局域网/Tailscale 的 Gateway + PWA 配对实验 |
| Phase 7 Journal / Recipe | 部分基础 | 已有 session notes、timeline、changed files 与测试入口可作为引用源 | 先做 workspace 绑定的手动 goal 与可编辑 Markdown handoff；Recipe 必须等真实 Journal 复用证据 |
| Herdr spike | 暂不进入关键路径 | GOAL 已记录实验边界 | 只有主线阶段验证后再单独决策 |
| Surface / Action / Dogfood | 未系统化 | Terminal、Review、Files 已有事实源边界，破坏性确认有局部实现 | 建立统一 SurfaceRef/ActionRef、feature flag、数据生命周期与本地可查看/关闭/清空的 dogfood 指标 |

## M1 执行账本，当前 Active Milestone

- [x] 固化进程冷启动、首个 PTY 可输入、输入回显、12 session 与 bundle 大小基线。5-run optimized bundle 中位数为窗口可见 502ms、首 PTY 可输入 1.639s、输入 p95 27ms、frame p95 18ms、RSS peak 413,088KiB、bundle 14,300KiB，见 [启动报告](./benchmarks/m1-terminal-startup-2026-07-11.md)。
- [x] 建立 50/200MiB Unicode/ANSI/OSC/alternate-screen 高输出 fixture 与 reference capture；本地 optimized bundle 顺序完整、溢出 0、frame p95 18/19ms，见 [报告](./benchmarks/m1-terminal-high-output-2026-07-11.md)。
- [x] 真实 WebGL context loss、atlas rebuild、renderer fallback 和 30 分钟压力证据。context loss -> DOM fallback -> reference 可见 -> 重新激活 WebGL 已通过；38 分 44 秒、16 GiB、64 轮压力全部顺序完整且 overflow 为 0，见 [高输出报告](./benchmarks/m1-terminal-high-output-2026-07-11.md)与[长压报告](./benchmarks/m1-terminal-stress-2026-07-11.md)。
- [x] SSH 输出 8ms / 128KiB 有界批处理与 2MiB xterm ACK 窗口已完成；真实 `de-netcup` optimized bundle 的 50/200MiB 均顺序完整、overflow 为 0、frame p95 18ms，CPU mean 4.78%，见 [SSH 高输出报告](./benchmarks/m1-ssh-high-output-2026-07-11.md)。
- [x] SSH 输入改为字节预算，大粘贴分块，Close 独立取消，Resize latest-value 合并；本地确定性测试与真实 `de-netcup` close/resize smoke 已通过。
- [x] 100/200ms RTT 下连接、目录、preview、grep、diff、SFTP 与取消已有真实 `de-netcup` 5 样本统计；optimized bundle 会话级断开在 279ms 内产生唯一 `-2`，原位 reconnect 2.888s 并恢复原 cwd，见 [RTT 报告](./benchmarks/m1-ssh-rtt-harness-2026-07-11.md)与[恢复报告](./benchmarks/m1-ssh-recovery-2026-07-11.md)。
- [x] 分屏创建的新终端保持当前 transport 与 cwd。旧安装版曾复现 SSH Codex 左 pane 位于 `/root`、新右 pane 却误落本机 `/Users/mawei`；修复后独立 `Tuna.app` Debug bundle 在真实 `de-netcup` 会话中从 `/root` 左 pane 创建 50/50 右 pane，连接阶段显示“正在协商 SSH”，就绪后两条侧栏会话均明确为 `root@de-netcup: ~`、`远程 SSH 会话 /root`，未降级到本机。
- [ ] Claude Code、Codex、Pi、OpenCode、Aider 和未知 TUI 的本地/SSH 兼容矩阵。TTY 基础层已形成可重复 smoke：5 个本地 Agent 与 5 个 SSH Agent 均完成启动 + resize，未知 TUI 的本地/SSH 完整协议合约及 10 类逐键传输合约通过；9/10 真实 Agent 格完整发送 `Esc`、Tab、Shift+Tab、四方向键、`Ctrl+R`、bracketed 多行和 `Ctrl+C`，7/10 观察到多行 marker，6/10 正常退出。SSH Claude 因 provider 失败在第 6 类后提前退出，未计完整传输。provider 快照 4/10 完成，3 格确认真实 tool event；后续 session 层已覆盖 10/10 本地/SSH Agent 格，其中本地 Claude、本地 Codex、本地 Pi、SSH Codex 已用明确会话身份和上下文 token 通过。本地/SSH Aider history 身份已落盘但 key 无法认证；SSH Claude 固定 UUID 身份已落盘但两轮均为 402；OpenCode 两端均已进入同一专用 session，但本地 timeout、SSH 凭据错误；SSH Pi 在创建 session 前缺 key，均不计 resume 通过。安装版内的未知 TUI、SSH Codex、本地 Pi 与本地 Claude 均已有实际分屏/后台/剪贴板证据；本地 Claude 还通过官方 `/exit`、可恢复态和 shell marker `TUNARA_CLAUDE_SHELL_OK` 证明正常退出。本地 Pi 的旧版永久误报已由 `118a1c5` 的忙碌优先策略和 `5fc3a0e` 的窄 pane/光标下方状态栏读取共同修复；独立 Debug bundle 在 50/50 pane 中真实通过 `加载中 → 就绪 → !sleep 3 运行中 → 就绪`，首次权限边界选择“不信任（仅本次）”且未授予持久信任。其余逐 Agent 按键语义、权限/确认、失败/resume、分屏、后台与复制粘贴证据仍未完成，见 [兼容性基线](./benchmarks/m1-agent-tui-compatibility-2026-07-11.md)。

- [x] SSH Aider 安装版交互补证：`de-netcup /root` 上 Aider 0.86.2 明确拒绝 OpenRouter 登录/建号与打开文档；固定 `openai/gpt-4o-mini` 在无 `OPENAI_API_KEY` 时显示 `AuthenticationError` 后恢复 prompt，不伪报 provider 成功。horizontal 50/50 分屏、Finder 后台切回、快速选择 6 项、受控 token `86.2` 精确复制粘贴且未提交、官方 `/exit` 与远端 shell marker `TUNARA_SSH_AIDER_SHELL_OK` 均通过。取证同时暴露安装版裸 OSC 133 `C` 将 Bash prompt 混入命令块、漏识别 Aider 并沿用旧 Codex 身份的问题；`ca79bf3` 已改为优先使用真实提交输入，并通过 123 项定向、423 项全量、typecheck、lint 与 build，新 bundle 实机复验仍待完成。

- [x] SSH OpenCode 安装版交互补证：远端交互式 Bash 的 `opencode` 命中旧 `/root/.opencode/bin/opencode` 1.1.56，系统 `/usr/local/bin/opencode` 已是 1.17.18；旧核心加载浮动 `oh-my-openagent@latest` 4.16.3 后在 `src/plugin/index.ts:90` 报 `fn3 is not a function`。warm cache、隔离 cache、隔离 HOME 对照与 Tunara 内 `type -a`/双版本输出共同证明这是远端 PATH/插件版本漂移，不是 Tunara transport 或渲染故障。使用明确路径 `/usr/local/bin/opencode --pure` 后，1.17.18 在 horizontal 50/50 分屏、Finder 后台切回、快速选择 4 项、token `1.17` 精确复制粘贴且未提交、`Ctrl+C` 清空、`/exit` 与远端 shell marker `TUNARA_SSH_OPENCODE_SHELL_OK` 全部通过；provider/resume 仍不宣称通过。

- [x] 本地 OpenCode 安装版交互补证与跨 Agent 恢复修复：OpenCode 1.17.18 以 `opencode --pure` 被识别为 `OpenCode · 运行中`，在 horizontal 50/50 分屏、Finder 后台切回、快速选择 3 项、token `1.17` 精确复制粘贴且未提交、`Ctrl+C` 清空、`/exit` 与本地 shell marker `TUNARA_LOCAL_OPENCODE_SHELL_OK` 全部通过。取证发现同一 pane 之前的 Claude `agentResume` 在 OpenCode 启停后仍残留，界面却用内存 `lastAgent` 错显 `OpenCode 可恢复`；`a956004` 在 Agent 身份切换时清除不匹配的旧 resume，并让历史脏快照优先显示真正恢复意图所属 Agent，115 项定向、424 项全量、typecheck、lint、build 均通过，新 bundle 实机复验仍待完成。

- [x] 本地 Codex 安装版交互补证与恢复链修复：Codex 0.144.1 以 read-only sandbox 在 horizontal 50/50 中与 SSH shell 共存，Finder 后台切回保持 session/split；首次信任 review 明确选择“不信任继续，hooks 不运行”且仍进入 ready prompt。真实 xterm 快照证明 `/` 打开命令菜单、`/perm` 过滤为 `/permissions`、`Ctrl+C` 清空并恢复 prompt；快速选择 4 项、token `5` 精确复制粘贴且未提交，官方 `/exit` 后普通 zsh 输出 `TUNARA_LOCAL_CODEX_MENU_SHELL_OK`。方向选择与多行编辑仍未宣称通过。取证发现“恢复”只预填不提交、污染下一条命令，以及精确 Codex session id 沿用旧 Claude source command 两个缺陷；`9a69d97` 已让恢复动作立即提交，`9202a37` 已将 source command 严格限定在同 Agent，当前源码 425 项全量、typecheck、lint、build 均通过。两个修复的新 bundle 实机复验仍待完成。

- [x] 本地 Aider 安装版安全边界与 compound 命令识别修复：在 `/tmp` 用 `uvx --from aider-chat aider --no-git` 启动，无 key 时明确拒绝 OpenRouter 登录/建号和打开文档，未伪报 provider 成功；horizontal 50/50、Finder 后台往返和普通 zsh marker `TUNARA_LOCAL_AIDER_SHELL_OK` 通过。安装版只检查首 token，导致 compound + uvx 包装未识别 Aider、交互回答 `n` 错作标题；`d8d6a2b` 已加入引号感知的 shell segment/word 解析和 `uvx --from` 识别，并以负例防止普通文本误报。87 项定向、425 项全量、typecheck、lint、build 均通过，新 bundle 实机复验仍待完成；clipboard/resume 本轮未宣称通过。

## Phase 1 验收账本

- [x] Repository identity 基于 canonical common git dir，不以展示目录名归并。
- [x] 当前 checkout 与 linked worktree 使用统一 `RepositoryRef / WorktreeRef / WorkspaceContext` 数据形状。
- [x] 本地、SSH 均提供只读 workspace discovery，远端无法证明 dirty 时显示未知而非伪装干净。
- [x] Session 概览展示 repository、worktree、branch、dirty 与其他 worktree。
- [x] Review 与 File Explorer 共用 Inspector 来源标签。
- [x] 侧栏表达 Repository -> Worktree -> Session，并展示 session / Agent 数量。
- [x] 扫描采用 TTL 缓存、watcher 主动失效和 React effect 取消过期回写。
- [x] 未激活的恢复会话按 transport + host + cwd 去重，最多两路后台 hydration，不把全量扫描放进 PTY 热路径。
- [x] 1,000 个恢复会话按 10 个唯一来源收敛为 10 次扫描，扫描复杂度不随 session 数直接放大。
- [x] bare repository、linked worktree、符号链接、detached/locked/prunable 解析有自动测试。
- [x] 失效本地 linked worktree 独立 fixture。
- [x] 同一路径位于不同 SSH 主机时 identity 不会错误归并。
- [x] 真实 Tauri app 中，本地中文 main + linked worktree 归入同一 repository，两个 PTY 均正常打开。
- [x] `root@100.83.112.82` 真实 SSH 恢复 `/root/qclaw-wechat-client` 后识别远端 workspace；目录不存在时连接成功、回落 home 并显示明确提示。
- [x] 576×433 窄窗口、vertical split、双 PTY、冷重启恢复与中文路径已在真实开发 bundle 验收。
- [x] 独立 optimized release 验收 bundle 在 640×480 下完成 vertical split、本地中文 linked worktree、真实 SSH cwd/workspace 与冷重启回归，未读写正式应用数据。
- [x] 10 条真实本地 PTY 同时存活，逐条写入/读回唯一 marker、接收 Exit 并清空物理/逻辑注册表；本机测试约 0.31 秒。
- [x] 10+ 已挂载 WebView 终端下的 renderer RSS、输入延迟和帧时间基线：12/12 ready，输入 p95 23ms，301 帧、frame p95 19ms，详见 [报告](./benchmarks/m0-terminal-baseline-2026-07-11.md)。
- [x] 可审阅截图覆盖 optimized release 的本地 linked worktree、真实 SSH 分屏、Workspace Inspector 与 16 个动物图标；截图发现并修复 CSP 阻断小 SVG 与 SSH bootstrap 回显，干净 SSH 会话复拍后直接落到目标目录提示符。

## 每阶段通用门禁

- TypeScript typecheck、lint、Node 测试。
- Rust fmt、clippy、单元测试。
- Frontend production build、Tauri release bundle。
- 旧持久化快照恢复与新增字段降级。
- 本地与 SSH IPC 参数、权限和失败边界。
- 真实 macOS bundle，真实 shell 与 SSH，窄窗/分屏/后台/重启。
- 大目录、大文件、长输出、断网重连、中文输入与快捷键。
- 多 worktree、多 Agent、外部文件修改和端口冲突。
- Agent Timeline 10,000 条事件、富内容懒加载、分页锚点、流式合并、内存和真实 bundle 帧时间。
- Companion 配对/撤销/轮换/重放/乱序/断线/抢占/锁屏敏感信息安全门禁。
- 每项新能力都有 feature flag、数据位置、导出/删除/保留策略以及关闭再开启恢复证据。

未满足的门禁保留为未完成，不因版本发布或单次 smoke 自动勾选。
