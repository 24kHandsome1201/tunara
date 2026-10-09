# Tunara

Tunara 是 terminal-first 的本地开发工作台：真实的本地与 SSH 终端，加上侧栏分组、检查面板里的只读上下文（文件、改动、Preview）和 Agent 状态感知。界面文案的写法见 [docs/COPY_GUIDE.md](./docs/COPY_GUIDE.md)，用词与本表一致。

## Language

### 终端与布局

**终端（Session）**:
一个真实的终端进程：本地登录壳，或经 SSH 连接打开的远程壳。侧栏里一项对应一个终端。
_Avoid_: 会话（仅限"恢复会话"语境）、标签页、tab、窗口

**SSH 连接**:
SSH 终端背后到主机的那条长连接；断线、重新连接、主机密钥确认都针对它。
_Avoid_: SSH 会话

**分栏（Pane）**:
终端或阅读面板在主区布局中占据的位置。拆分会新建一个终端放进新分栏；一个窗口最多 4 个分栏。
_Avoid_: 分屏、split 窗口

**阅读面板（Reader）**:
在终端旁的分栏里查看文件或改动的区域，归属于一个终端。
_Avoid_: 文件预览、文件标签、预览窗

**目录组**:
侧栏里的分组：本地终端按工作目录归组，SSH 终端按主机归组。
_Avoid_: 项目、文件夹

**工作区（Workspace）**:
跨重启保存和恢复的整体状态：终端列表、布局、终端输出与 Agent 恢复意图。
_Avoid_: 会话列表、快照

### 检查面板

**检查面板（Inspector）**:
主窗口右侧的辅助区域，提供当前终端所需的上下文。
_Avoid_: 检查器、右栏、侧面板

**视图**:
检查面板里的一页：文件、改动、Preview、传输、端口转发。
_Avoid_: 页签、tab

### 仓库

**仓库（Repository）**:
终端所在的 git 仓库；改动视图和 Preview 都绑定到仓库及其 worktree，而不是绑定到目录。
_Avoid_: 工作区、Workspace、项目

**Worktree**:
仓库下的一个工作树；同一仓库的多个 worktree 共享仓库身份。

### 注意力

**需要你（Attention）**:
Tunara 判断出要用户处理的终端：Agent 在等确认、命令失败且未查看，或 SSH 连接需要处理。
_Avoid_: 提醒、待办

**终端通知**:
终端里运行的程序自己发出的通知；与「需要你」是两回事。
_Avoid_: 需要你、提醒

**待处理**:
HerdR 报告的 blocked pane 状态；它会计入「需要你」。

### Agent 与多路复用器

**Agent**:
Tunara 识别出的 coding agent CLI：Claude Code、Codex、Cursor、OpenCode。其他 CLI 是普通终端进程。
_Avoid_: AI 助手、机器人

**多路复用器**:
在一个终端里再管理多个 pane 的程序：HerdR、tmux、zellij。Tunara 只读取它们的状态。
_Avoid_: 复用器、tmux（泛指时）

### SSH

**主机（Host）**:
保存下来的 SSH 目标，不含凭证；连接成功后自动保存。
_Avoid_: 服务器、profile、连接配置
