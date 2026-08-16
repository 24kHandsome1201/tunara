# 其他终端对比：Tunara 还没做的

调研日期：2026-08-16。对照的是 Tunara 当前主线（`FEATURES.md` / 代码），不是发版宣传口径。

这份文档只回答一件事：**别的终端每天在用的能力，Tunara 缺哪些，以及缺了该不该补。**  
功能入口仍以 [FEATURES.md](./FEATURES.md) 为准；产品边界以 [GOAL.md](./GOAL.md) 为准。

## 对比对象

按 Tunara 自己的定位分组，而不是按星标数：

| 组 | 产品 | 为什么拿来比 |
|----|------|----------------|
| 用户从这里离开 | **iTerm2**、macOS Terminal | README 写明的目标用户：装回 iTerm 仍觉得缺点什么 |
| GPU 原生终端 | **Ghostty**、**Kitty**、**WezTerm** | 终端本职（协议、渲染、快捷操作）的 2026 年基准 |
| AI / 工作区终端 | **Warp**、**Wave**、**cmux** | README 点名的竞品；侧栏 + Agent 工作流 |
| SSH 客户端 | **Tabby**、**Termius**、Kitty SSH kitten | Tunara 已有 russh 长连接，要比远程本职而不是包装 `/usr/bin/ssh` |

Alacritty 刻意极简（无原生分栏），不作为功能对标。Hyper 已停滞。Windows Terminal 只在 Windows 官方支持成为目标时才有意义。

## 先看结论

终端本职（PTY、WebGL、OSC 7/8/52/133、命令块、搜索、安全粘贴、分栏、会话恢复）已经够用，不必再堆 iTerm 式厨房水槽。

真正还没做、又对得上 Tunara 的，集中在四类：

1. **macOS 终端的肌肉记忆**：把文件拖进终端变成转义路径；选区之外的缓冲导出。
2. **多 Agent 并行时的注意力**：OSC 99、一键跳到最近需要处理的会话。侧栏动态和 OSC 9/777 已经有了，缺的是协议完整性和键盘路径。
3. **命令块的二次利用**：导出块/滚屏到文件；长命令完成时带时长的提醒（草案 [PR #75](https://github.com/24kHandsome1201/tunara/pull/75)）。
4. **现代 TUI 协议**：Kitty keyboard、Unicode grapheme 宽度。xterm.js 上游不完整，适合跟踪，不适合现在硬做。

下面三类不要当成缺口：产品已实现、已经写明不做、或会把 Tunara 做成下一个 Warp/IDE。

## Tunara 已经不弱的地方

对比时容易漏掉这些，所以先钉住：

| 能力 | Tunara | 多数纯终端没有 |
|------|--------|----------------|
| 按工作目录分组的会话侧栏 | 有 | iTerm2 / Ghostty / Kitty 仍是 tab 森林 |
| 12 种 Agent CLI 识别 + 忙闲/确认 | 有，不替你跑 Agent | Warp/Wave 走内置 AI；cmux 走通知环 |
| 只读 Git review 轨 | 有，永不 stage/commit/push | 纯终端没有；Warp/Wave 往往会写仓库 |
| russh 长连接 + SFTP + 传输 journal + 转发 + 远程 Git | 有 | iTerm2/Ghostty/Kitty 通常只包一层 `ssh` |
| 工作区绑定 Preview | 有，不扫端口 | Wave/cmux 是通用内嵌浏览器 |
| 命令块 + Quick Select + 安全粘贴 + 分栏广播 | 有 | 各家只做其中一两项 |
| ~30 MB、无账号、无遥测 | 有 | Warp 安装包大约 150–230 MB，且偏云 |

侧栏会话卡已经显示 Git 分支。全局唤起（⌘⇧T）、OSC 9 / OSC 777 通知、OSC 9;4 进度条、可选 OSC 52 写剪贴板、连字、正则搜索、分栏输入广播，代码里都在。不要把它们再报成缺口。

[PR #75](https://github.com/24kHandsome1201/tunara/pull/75)（草案，未合入）补的是命令块右键状态/时长，以及未聚焦会话的长命令完成提醒。那是「已开工」，不是「没做」。

---

## 矩阵：终端本职

图例：✓ 有 · ◐ 部分 / 有边界 · ✗ 无 · — 明确不做或非目标

| 能力 | Tunara | iTerm2 | Ghostty | Warp | Kitty | WezTerm | Wave | cmux |
|------|--------|--------|---------|------|-------|---------|------|------|
| GPU 渲染 | ✓ WebGL | ✓ Metal | ✓ Metal | ✓ | ✓ | ✓ | WebKit | libghostty |
| 分栏 | ✓ 最多 4 | ✓ 任意 | ✓ | ✓ | ✓ | ✓ | 磁贴工作区 | ✓ |
| 会话恢复 | ✓ 含 scrollback | ✓ | ◐ | ✓ | ✗ | ✓ mux | ✓ | ✓ |
| 命令块 | ✓ OSC 133 | ✓ Shell Integration | ✓ | ✓ 核心模型 | ✗ | ✗ | ✗ | ✗ |
| 终端搜索 | ✓ 含正则 | ✓ 含全局搜 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Quick Select / hints | ✓ | Smart Selection | ✗ | ✗ | kitten hints | ✗ | ✗ | ✗ |
| 安全/括号粘贴 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 拖文件 → 转义路径 | **✗** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ? |
| copy-on-select | — 已砍 | 可选 | 默认开 | 可选 | 可选 | 可选 | 可选 | 可选 |
| 键盘 copy mode | — 已砍 | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| OSC 8 / 7 / 133 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OSC 52 写剪贴板 | ✓ 默认关 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OSC 9 / 777 通知 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OSC 99 通知 | **✗** | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| OSC 9;4 进度 | ✓ | ✓ | ✓ | ? | ✓ | ✓ | ? | ? |
| SIXEL / iTerm IIP | ✓ | IIP | ✓ | ✗ | ✗ SIXEL | ✓ | ? | Ghostty 栈 |
| Kitty graphics | — 已放弃 | imgcat 子集 | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| Kitty keyboard | **✗** 等上游 | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ |
| Unicode grapheme 宽 | **✗** xterm 默认 | ✓ | ✓ | ? | ✓ | ✓ | ? | ✓ |
| 行时间戳 | **✗** | ✓ | ✗ | 块时间 | ✗ | ✗ | ✗ | ✗ |
| 导出滚屏/块到文件 | **✗** | ✓ | ✗ | 分享块 | ✗ | ✗ | ✗ | ✗ |
| 跨会话全局搜索 | **✗** | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 滚屏词自动补全 | **✗** | ✓ ⌘; | ✗ | AI 补全 | ✗ | ✗ | AI | ✗ |
| 粘贴历史 | **✗** | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Instant Replay | — | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Triggers 自动回写 | — | ✓ | ✗ | ✗ | ✗ | Lua | ✗ | CLI |
| tmux -CC | — | ✓ 独有 | ✗ | tmux warpify | ✗ | 自有 mux | ✗ | 远程 tmux beta |
| 多窗口 | **✗** 单窗 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 内置 AI / MCP | — | 可选插件 | ✗ | ✓ | ✗ | ✗ | ✓ | ✗ 原语 |
| 插件市场 | — | Python API | 实验 Lua | Drive | kittens | Lua | 小部件 | socket CLI |

「?」表示公开文档不足以诚实打勾，不把它算进 Tunara 缺口。

---

## 还没做、且符合定位

只列 Tunara 会用、且不违反「不替用户跑命令 / 不做成 IDE」的项。按投入产出排序。

### 1. 把文件拖进终端，插入转义路径

**谁有：** iTerm2、Ghostty、Kitty、WezTerm、Warp、Wave（v0.14.5 才补上 Finder drop）。

**现状：** Files 面板能接收拖放并上传；`TerminalView` 没有 `onDrop`。从 Finder 拖一个路径进来，什么都不会插入。

**为什么值得做：** 这是 macOS 终端的肌肉记忆，和「选择目录新建终端」同一类：减少手打路径。转义后写入 PTY 即可，不自动回车，和现有 `pendingInputSubmit: false`、安全粘贴同一哲学。

**注意：** 只插入路径，不要对拖入的文件自动 `cat` / 上传 / 打开。SSH 会话插入的是远端不可达的本地路径时，要有可见提示。

### 2. OSC 99 桌面通知

**谁有：** Ghostty、cmux。Claude Code / OpenCode 一类 Agent 越来越多走 OSC 99，而不只是 OSC 9/777。

**现状：** OSC 9 通知、OSC 9;4 进度、OSC 777 `notify` 都已接到 toast + Dock bounce（受铃铛开关约束）。没有 OSC 99 handler。

**为什么值得做：** 这是协议完整，不是新产品面。cmux 的卖点之一就是「哪个 pane 在等你」；Tunara 已有未读点和 Attention 条，缺的是 Agent 实际在发的那种通知序列。实现应复用 `emitTerminalNotification`，遵守现有长度上限和 `bellNotification` 开关。

### 3. 一键跳到最近需要处理的会话

**谁有：** cmux（⌘⇧U 跳最近未读）。iTerm2 有 activity 通知，但没有同样的「跳到那个 pane」。

**现状：** 侧栏「需要处理 / 正在运行 / 可恢复」可点，没有快捷键。`keybindings.ts` 里没有 unread/attention 动作。

**为什么值得做：** Tunara 已经派生了 Attention，缺的是键盘路径。动作只聚焦会话（SSH 断线仍只打开重连，不自动跑命令），与现有 Attention 合同一致。

### 4. 导出滚屏或命令块到文件

**谁有：** iTerm2（保存缓冲 / Instant Replay 导出）、Warp（分享块）、部分 SSH 客户端的 session log。

**现状：** 只能复制到剪贴板。大文件查看已经有 256 KiB / 2000 行上限，导出应对齐同一预算，避免把 20k 行快照整份写出。

**为什么值得做：** Agent 输出和构建日志经常要留一份，而不只是贴到聊天里。只做显式「另存为」，默认关、不写遥测、不自动 session log。

### 5. Unicode grapheme / emoji 宽度

**谁有：** Ghostty、Kitty、WezTerm、iTerm2。Agent CLI 输出大量 emoji 和组合字符。

**现状：** xterm.js 默认宽度；未加载 `@xterm/addon-unicode-graphemes`。文档里的 Agent TUI 基线已经碰到 Codex 的 Kitty keyboard / 重绘问题，宽度是下一层。

**为什么值得做：** 错位会让分屏 TUI「看起来坏了」。这是渲染正确性，不是新功能。先在现有 `m1-agent-tui` 场景上量内存和错位，再开。

### 6. Kitty keyboard protocol

**谁有：** Ghostty、Kitty、WezTerm、cmux（Ghostty 栈）。Codex / 新 TUI 依赖它区分修饰键。

**现状：** 未实现。xterm.js 上游不完整。Tunara 用 tmux verifier 绕过 Codex 的 keyboard protocol 做语义测试，不等于产品支持。

**为什么值得做：** 等上游可加载再接。现在自研协议解析会和 WebGL/输入路由打架，投入不对。

### 7. 可选行时间戳

**谁有：** iTerm2（每行最后修改时间）。Warp 把时间放在块上。

**现状：** 命令块内部有 `startedAt` / `completedAt`（PR #75 用它做时长），没有「每一行何时出现」。

**为什么值得做：** 排查「这段日志是十分钟前还是刚才刷的」时有用。必须默认关，避免弄脏拷贝；复制应仍是纯文本。块级时长优先于行级时间戳。

### 8. 当前窗口内的跨会话搜索

**谁有：** iTerm2 Global Search、Warp。

**现状：** ⌘F 只搜当前 pane。

**为什么值得做：** 多个 Agent 同时跑时，「哪次构建打出了这个错误」是真问题。保持只读、有结果上限，不要做成持久日志搜索（那是已撤销的 Agent Timeline）。

### 9. 滚屏词补全（iTerm2 ⌘;）

**谁有：** iTerm2。Warp 用 AI 补全，那是另一件事。

**现状：** 没有。Quick Select 提取 URL/路径/词条，但不插入到提示符。

**为什么值得做：** 从当前缓冲挑一个 token 插入，不调用模型、不自动提交。可做成 Quick Select 的「插入」动作，而不是第二套补全 UI。

### 10. 有上限的粘贴历史

**谁有：** iTerm2。

**现状：** 每次粘贴都走安全粘贴，不保留历史。

**为什么值得做：** 反复粘同一段远程命令很常见。只保留最近 N 条纯文本，放本机，不进工作区快照，不与 OSC 52 远程写入混用。优先级低于拖放路径和 OSC 99。

---

## SSH 专项：比 Tabby / Termius / Kitty 还缺什么

Tunara 的 SSH 已经超过「在 PTY 里跑 `ssh`」：自有连接、SFTP、批量传输、冲突检测写入、远程 Git、本机/动态/回环 RemoteForward、诊断、config 导入。下面才是相对专职客户端的缺口。

| 缺口 | 谁有 | 建议 |
|------|------|------|
| SSH agent forwarding | Tabby、OpenSSH | 有真实跳板场景再做；权限面比 ProxyJump 单跳大 |
| FIDO / PKCS#11 / 原生 Windows agent | OpenSSH、Termius | 文档已写明不做；要做就先有硬件验收环境 |
| `ProxyCommand` / `Match exec` | OpenSSH、Tabby | 明确拒绝：任意本地命令 |
| X11 转发 | Tabby | 非目标（不是 macOS 开发工作台的主路径） |
| Zmodem | Tabby | 有 SFTP journal 后价值低 |
| Mosh / 串口 / Telnet | Termius、Tabby、WezTerm | 非当前平台承诺 |
| 云端保险库同步 / 多人实时看会话 | Termius | 明确非目标（本地优先、无账号） |
| 把密码写入 profile | Tabby、Termius、iTerm 密码管理 | **保持现状**：口令只在单次连接内存里 |
| Kitty transfer kitten（走 TTY 传文件） | Kitty | Tunara 用 SFTP 更稳；嵌套 SSH 场景才需要 TTY 传输 |
| WezTerm 远程 mux 服务 | WezTerm | 接近自建 tmux；与「真实 PTY」重叠，不优先 |

SSH 下一阶段仍应是 [ROADMAP.md](./ROADMAP.md) 里的真实环境回归（认证方式、host key、被动断开、大目录搜索），而不是再铺协议。

---

## 还没做、但已经决定不做

这些在竞品矩阵里是 ✗，**不要当 backlog**。

| 项 | 记录在 | 原因 |
|----|--------|------|
| 拖选即复制 | [TERMINAL_SELECTION_COPY.md](./TERMINAL_SELECTION_COPY.md) | 静默覆盖系统剪贴板，不符合 macOS |
| tmux 风格 copy mode | 同上 | GUI 用鼠标；工作量大且偏题 |
| 中键粘贴 | 同上 | X11 primary selection，macOS 无此范式 |
| Kitty graphics protocol | `terminal-image.ts` | 更重、仍在变，SIXEL/IIP 已够预览 |
| 无限递归分栏 | GOAL / FEATURES | 硬上限 4 pane |
| Triggers 匹配输出后自动向 PTY 写 | GOAL | 等于替用户敲命令 |
| Instant Replay 逐帧回放 | — | 每会话数 MB 视频式缓冲，和轻量目标冲突 |
| 内置密码库保存 SSH 口令 | SSH 连接文案 | 口令不得写入 profile / 快照 |

分栏广播输入**已经有了**（命令面板 + 终端菜单 + `broadcast-input.ts`）。不要再把它列进缺口。若发现性不足，那是文案/视觉问题，不是功能缺失。

---

## 还没做、属于明确非目标

从 Warp / Wave / iTerm 厨房水槽抄过来会直接违反 GOAL：

- 内置 AI 聊天、模型补全、MCP 编排、Cloud Agent
- Agent 启动器、catalog、自动向 PTY 填命令并回车
- 持久 Agent Timeline / 事件全文搜索 / 富 payload（已从主线撤掉）
- Diff 面板里的 stage / commit / push
- 插件市场、Python/Lua 脚本任意控制 PTY
- 通用内嵌浏览器（Wave/cmux 那种）；Tunara 只做来源绑定的 Preview
- 遥测、账号、云 workspace、跨设备保险库
- 完整 IDE 编辑器（Wave 的 VS Code-like remote editor）；Tunara 只做有边界的单文件写

cmux 的 scriptable browser + socket API 很强，但那是「Agent 原语平台」。Tunara 的选择是认出 Agent、标出注意力、把决定留在真实终端里。

---

## 建议的落地顺序

若要从这份调研里开实现，而不是继续扩文档：

1. **拖文件到终端 → 转义路径**（最小、每天用、与现有粘贴保护同路）
2. **OSC 99**（复用现有通知管道）
3. **跳转到最近 Attention 会话**（复用 `deriveSessionAttention`，加一个快捷键）
4. 合入或收口 [PR #75](https://github.com/24kHandsome1201/tunara/pull/75)（块时长 + 长命令提醒）
5. **导出块/滚屏到文件**（对齐 256 KiB 上限）
6. 量完再做：Unicode graphemes、跨会话搜索、Quick Select「插入」、Kitty keyboard（等 xterm.js）

平台向的 Linux/Windows 正式发布、多窗口、quake 下拉动画，都不是终端协议缺口，不在本清单里推进。
