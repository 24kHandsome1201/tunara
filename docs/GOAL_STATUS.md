# Tunara Goal 交付与证据矩阵

本表将 [GOAL.md](./GOAL.md) 的方向拆成可验证增量。状态只依据已合入实现和本轮真实证据更新，不以入口、占位 UI 或计划文档代替完成。

## 当前结论

当前唯一 Active Milestone 是 `M0 Phase 1 真实验收`。在本节未完成项全部有真实证据前，不启动编辑器、Preview、Timeline、Companion 或 Recipe。M0 完成后先进入 `M1 Terminal + SSH 性能与乱码稳定性`。

| 阶段 | 状态 | 当前证据 | 下一道完成门 |
|---|---|---|---|
| Phase 1 Workspace / Worktree | 进行中 | common git dir 稳定身份、本地 linked worktree 发现、SSH 同形解析、概览与 Inspector 来源、侧栏层级表达、缓存与取消过期前端请求 | 真实本地多 worktree 与 SSH 回归，大量 session 性能，失效 worktree fixture，正式 bundle 验收 |
| Phase 2 Markdown / 单文件轻编辑 | 未开始 | 已有只读文件预览与外部编辑器逃生口 | 阅读器、冲突检测、本地安全写、SSH 原子写回完整闭环 |
| Phase 3 Workspace Preview | 未开始 | 终端已有 URL 检测基础能力待盘点 | workspace 绑定、安全 WebView、来源/截图/错误摘要闭环 |
| Phase 4 Agent Attention / Timeline | 部分基础 | 已有 PTY 内 Agent 探测、状态证据、恢复意图、轻量 session timeline、完成提醒与 diff 入口 | 事件 header/payload 分离、Rust append-only 持久层、游标分页、10,000 事件虚拟列表与性能证据 |
| Phase 5 Worktree 生命周期 | 未开始 | Phase 1 只读模型正在建立 | 创建/删除安全检查、恢复扫描、本地与 SSH 一致语义 |
| Phase 6 Mobile Companion | 未开始 | Phase 1 稳定 identity 正在建立；桌面仍是唯一事实源 | 等 Phase 4 事件模型稳定后，先做默认关闭、只读、局域网/Tailscale 的 Gateway + PWA 配对实验 |
| Phase 7 Journal / Recipe | 部分基础 | 已有 session notes、timeline、changed files 与测试入口可作为引用源 | 先做 workspace 绑定的手动 goal 与可编辑 Markdown handoff；Recipe 必须等真实 Journal 复用证据 |
| Herdr spike | 暂不进入关键路径 | GOAL 已记录实验边界 | 只有主线阶段验证后再单独决策 |
| Surface / Action / Dogfood | 未系统化 | Terminal、Review、Files 已有事实源边界，破坏性确认有局部实现 | 建立统一 SurfaceRef/ActionRef、feature flag、数据生命周期与本地可查看/关闭/清空的 dogfood 指标 |

## M1 预备账本，当前不开工

- [ ] 固化冷启动、首个 PTY 可输入、输入回显、10 session、bundle 大小基线。
- [ ] 建立 50/200MiB Unicode/ANSI/OSC/alternate-screen 高输出 fixture 与 reference capture。
- [ ] 真实 WebGL context loss、atlas rebuild、renderer fallback 和 30 分钟压力证据。
- [ ] SSH 输出 4-16ms 或 64-256KiB 有界批处理，记录 IPC/CPU/RSS/p95 frame time。
- [ ] SSH 输入改为字节预算，大粘贴分块，Close 独立取消，Resize latest-value 合并。
- [ ] 100/200ms RTT 下连接、目录、preview、grep、diff、取消与恢复 benchmark。
- [ ] Claude Code、Codex、Pi、OpenCode、Aider 和未知 TUI 的本地/SSH 兼容矩阵。

## Phase 1 验收账本

- [x] Repository identity 基于 canonical common git dir，不以展示目录名归并。
- [x] 当前 checkout 与 linked worktree 使用统一 `RepositoryRef / WorktreeRef / WorkspaceContext` 数据形状。
- [x] 本地、SSH 均提供只读 workspace discovery，远端无法证明 dirty 时显示未知而非伪装干净。
- [x] Session 概览展示 repository、worktree、branch、dirty 与其他 worktree。
- [x] Review 与 File Explorer 共用 Inspector 来源标签。
- [x] 侧栏表达 Repository -> Worktree -> Session，并展示 session / Agent 数量。
- [x] 扫描采用 TTL 缓存、watcher 主动失效和 React effect 取消过期回写。
- [x] 未激活的恢复会话按 transport + host + cwd 去重，最多两路后台 hydration，不把全量扫描放进 PTY 热路径。
- [x] bare repository、linked worktree、符号链接、detached/locked/prunable 解析有自动测试。
- [x] 失效本地 linked worktree 独立 fixture。
- [x] 同一路径位于不同 SSH 主机时 identity 不会错误归并。
- [ ] 真实本地 main + linked worktree UI 验收。
- [ ] 至少一台真实 SSH 主机的 worktree UI 与降级验收。
- [ ] 大量 session 下扫描去重和 PTY 输入无可感知回归。
- [ ] 窄窗口、分屏、重启恢复、中文路径正式 bundle 验收。

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
