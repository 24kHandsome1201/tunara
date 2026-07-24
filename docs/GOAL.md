# Tunara 产品目标

## Goal

Tunara 是 terminal-first 的本地开发工作台：保持真实 PTY 与 SSH 语义，同时提供轻量 workspace/worktree 上下文、只读 review、Preview 和 Agent 辅助。

它不替代 shell、Git、浏览器、编辑器或 Agent。Tunara 的职责是让这些真实工具在同一个 workspace 中更容易观察、切换、衔接和验证，并把最终决定留给用户。

## 产品原则

- **Terminal-grounded**：终端输入、输出、alternate screen、标题栏、WebGL 与剪贴板边界保持真实且可降级。
- **Workspace-first**：本地与 SSH session 都绑定明确来源；review 与 Preview 不猜测来源。
- **Local-first**：会话与用户设置留在本机；失败不能阻断普通终端。
- **Safe writes**：Markdown/单文件编辑及 SSH safe-write 保持冲突检测和显式确认。
- **Contextual, not all-in-one**：Inspector 提供当前任务所需上下文，不建设 IDE 或 Agent 聊天壳。

## 当前已交付范围

1. Workspace/worktree 感知与只读 Git review。
2. 稳定的本地 PTY、SSH、SFTP、resume 与终端恢复。
3. Markdown 阅读和有边界的单文件轻编辑。
4. Workspace-bound Preview，包括来源验证、导航、viewport、截图、失败摘要和显式 SSH tunnel。
5. 轻量 Agent 检测、生命周期状态、Attention、resume，以及 Overview 中仅限当前运行期的最近活动。

一条完整但透明的使用路径是：进入 repository/worktree，恢复终端和上下文，阅读或轻改文件，观察绑定的 Preview，审阅真实文件变化，再由用户决定后续 Git 操作。

## 平台支持

- macOS Apple Silicon 是正式支持、签名和发布的平台。
- Linux 和 Windows 仅作为实验性源码构建目标，不提供官方安装包或完整原生 Preview 承诺。
- Linux CI 验证共享编译与测试面；这不能替代目标平台实机验收，也不等于正式支持。

## Agent 边界

Agent 支持只服务于“看见当前状态并回到真实终端”：

- 保留 hook/wrapper、命令检测、运行状态、等待确认提醒、resume 和 lightweight session activity。
- 最近活动由内存中的 `sessionTimelines` 提供，不是长期历史或审计日志。
- 不提供持久 Agent Event Store、全文搜索、富 payload、Inspector Agent Timeline 或聊天记录。
- 不解析私有 Agent stdout 布局，不把完整 PTY scrollback 当作结构化历史。
- 不自动清理旧版本已经写入的 app data；v1.16 升级用户可在 Settings > App 明确确认后删除固定的旧 Agent 数据目录。

完整的持久 Event Store、Timeline UI、全文搜索和富 payload 原型已经过实现与评估，随后因当前产品价值不足而从主线移除。删除前状态保存在远端 `archive/agent-timeline-v1` 分支；该分支是历史参考，不是当前支持面或回归承诺。

## 明确不做

- IDE 级语言服务、调试器、完整 SCM 或通用文件编辑器。
- Agent orchestration、自动审批、自动向 PTY 写入命令或多 Agent 控制台。
- 持久 Agent Timeline/Event Store、事件全文搜索、富 payload 展示或后台上传。
- 以结构化解析 Agent stdout 代替真实终端。
- 自动 stage、commit、push、merge、rebase、发布或破坏性回滚。
- 插件市场、云 workspace、遥测体系或完整移动端远程控制。

## 完成与回归

当前主线没有自动进入的“下一阶段”。后续产品扩张必须先证明高频用户价值、明确数据与权限边界，并重新批准；现有回归重点是 PTY/SSH、Preview、safe-write、轻量 Agent Attention/resume、Overview 最近活动，以及三套自动测试门。
