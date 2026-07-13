# Tunara Goal：以真实终端为事实源的个人开发工作台

## 1. 文档目的

这份文档定义 Tunara 下一阶段的长期产品方向和可独立交付的开发阶段，作为后续需求判断、实现拆分和验收的共同依据。

它不是版本承诺，也不是要求一次完成的功能清单。每个阶段都必须在单独交付后形成可使用的产品增量；后续阶段即使停止，已经交付的阶段也应保持完整价值。

## 2. Goal

Tunara 从“带智能侧栏的真实终端”演进为：

> 以真实终端为事实源，围绕当前 workspace 组织执行、上下文、结果、变化和注意力的个人开发工作台。

Terminal 仍然是产品中心，但不再是唯一的工作 surface。文件、Markdown、浏览器预览、Git worktree、变更审阅和 Agent 状态都应围绕同一 workspace 建立明确关系，减少开发过程中的上下文切换。

Tunara 不替代 shell、Git、浏览器、编辑器或 Agent。它负责让这些真实工具在同一个工作上下文里更容易观察、切换、衔接和验证。

## 3. 成功标准

方向成功时，用户能够在 Tunara 中完成一条连续且透明的开发循环：

```text
进入 repository / worktree
  -> 恢复相关终端和上下文
  -> 阅读文档或进行小范围文件修改
  -> 启动服务或 Agent
  -> 在绑定的浏览器预览中查看结果
  -> 将截图、错误或文件位置送回对应 Agent
  -> 审阅真实文件变化
  -> 由用户决定后续 Git 操作
```

衡量标准：

1. 用户不再为了阅读 Markdown、修改一处配置或查看本地页面而被迫离开当前 workspace。
2. 任意终端、Agent、预览、文件和 diff 都能明确回答“属于哪个 repository/worktree”。
3. 多个 Agent 并行运行时，用户能快速知道谁正在工作、谁等待处理、谁已经完成或失败。
4. 所有写操作都透明、可撤销或有冲突保护；Tunara 不替用户做提交、合并或发布决定。
5. 新能力不显著损害终端启动速度、输入延迟、PTY 真实性和离线/本地优先属性。

## 4. 产品原则

### 4.1 Workspace-first

产品的核心上下文逐步从单个 session 上升为 workspace/worktree：

```text
Repository
└── Workspace / Worktree
    ├── Terminal：真实执行环境
    ├── Agent：PTY 中可观察、可恢复的执行者
    ├── Files：上下文阅读与小范围修改
    ├── Markdown：文档阅读
    ├── Preview：当前工作树运行出来的结果
    └── Review：当前工作树的真实变化
```

Session 仍然是一等运行对象，但不再独自承担项目上下文。

### 4.2 Terminal-grounded

- Terminal 使用真实 PTY；命令、进程和输出始终可见。
- Agent 运行在真实终端中，Tunara 不伪造聊天层或隐藏底层命令。
- Git 状态来自真实仓库，文件状态来自真实文件系统。
- Preview 必须标明来源 workspace、进程、端口或 URL。

### 4.3 Contextual, not all-in-one

功能是否进入 Tunara，不再以“传统终端是否应该拥有它”判断，而以三个问题判断：

1. 它是否直接服务于当前 workspace？
2. 它是否保持底层工具和真实状态透明可见？
3. 最终决定是否仍然属于用户？

三个答案都是“是”时，可以进入产品；否则默认拒绝。

### 4.4 Local-first and honest degradation

- 默认本地运行，不要求云账号，不上传 workspace 内容。
- SSH、浏览器、Agent hook 或外部工具不可用时，应清楚降级，不伪造成功状态。
- 无法可靠判断 Agent 状态时使用 `unknown`，不把启发式判断用于破坏性自动操作。

### 4.5 Safe writes

- 本地和远程文件保存必须检测冲突。
- 远程写入使用临时文件加原子替换；保留权限和合理的失败恢复。
- Worktree 删除必须检查 dirty、未推送提交和运行中的进程。
- 高风险操作需要明确确认，默认不自动执行。

## 5. 明确不做

以下内容不属于这个 Goal：

- 内置模型 API、模型路由、计费或云端对话服务。
- 自建 Agent 对话记录和替代真实 PTY 的聊天界面。
- 自动任务拆解、多 Agent 自主调度和隐藏式批量启动。
- LSP、智能补全、调试器、项目级重构和完整 IDE。
- 通用网页浏览器、书签、账号、密码和扩展系统。
- 自动 stage、commit、push、merge、rebase 或发布。
- 插件市场、云工作区或遥测体系。
- 完整远程桌面、手机 IDE 或以手机长期操作 shell 为目标的产品。
- 将 Mac 直接暴露为公网监听服务，或默认把完整终端历史上传到云端。
- 直接复制、链接或嵌入 AGPL Herdr 源码。

允许的例外必须仍符合 Workspace-first、Terminal-grounded 和用户最终决定三项原则。

## 6. 阶段计划

## Phase 1：Workspace / Worktree 感知

### 目标

建立后续所有能力共享的上下文模型。先正确识别和展示，不急于执行复杂 Git 写操作。

### 范围

- 识别当前目录所属 repository 和 worktree。
- 发现同一 repository 的其他 worktree。
- 建立稳定的 repository/worktree identity，不只依赖展示路径。
- 侧栏支持 `Repository -> Worktree -> Session` 的关系表达。
- 展示分支、dirty、ahead/behind、关联 session 和 Agent 数量。
- Session、Review、File Explorer 和后续 Preview 共享同一 worktree context。
- 本地和 SSH 使用一致的数据形状；远端能力不可用时明确降级。

### 非范围

- 创建、删除、合并或 rebase worktree。
- 自动迁移现有 session。
- 改变当前 Git Review 的只读原则。

### 验收

- 同一仓库的 main checkout 和多个 linked worktree 能正确归组。
- 同名目录、符号链接和远程路径不会错误归并。
- 每个 session、diff 和文件面板都能显示其 worktree 来源。
- Git 不可用、非仓库和 worktree 元数据损坏时不会阻塞终端。
- 大量 session 下不会因持续扫描造成明显输入或渲染延迟。

## Phase 2：Markdown 阅读与单文件轻编辑

### 目标

闭合阅读文档和修改小型配置文件的高频断点，同时保持外部编辑器是复杂编辑的主路径。

### 范围

- 强化 Markdown/MDX 阅读：标题目录、锚点导航、搜索、代码块、表格和源码/预览切换。
- 在右侧 surface 打开单个本地或 SSH 文本文件。
- 提供行号、查找、撤销/重做、基础语法高亮和保存。
- 保存前比较读取版本，检测外部修改。
- SSH 保存采用原子写回，并保持文件权限。
- 大文件、二进制文件或不支持的编码继续只读或跳转外部编辑器。
- 保留“在外部编辑器打开”作为显著逃生口。

### 非范围

- 多标签工程编辑体验。
- LSP、补全、格式化、重构和调试。
- Agent 自动修改尚未保存的编辑缓冲区。

### 验收

- 本地和 SSH Markdown 阅读行为一致。
- 普通配置文件可以完成读取、修改、保存和重新打开验证。
- 外部修改会触发冲突提示，不会静默覆盖。
- SSH 断线、权限不足和写入失败不会破坏原文件。
- 编辑器不会抢占默认启动焦点，也不会拖慢终端启动。

## Phase 3：Workspace-bound Browser Preview

### 目标

让用户在当前 worktree 内观察和验证运行结果，而不是构建通用浏览器。

### 范围

- 自动识别终端输出中的 localhost/开发服务 URL。
- 用户点击后在 Preview surface 打开，或选择外部浏览器。
- Preview 与 workspace、worktree、session 和来源 URL 绑定。
- 支持刷新、前进/后退、地址导航、缩放和常用 viewport。
- 支持截图并保存来源信息。
- 展示基础 console error 和 network failure 摘要。
- 服务退出或端口失效时，关联回来源终端和重启入口。
- 为 SSH preview 设计明确的连接方式；无法安全直连时使用显式端口转发，不静默改变远端配置。

### 非范围

- 通用浏览器标签管理、书签、密码、扩展和账号同步。
- 重做完整 DevTools。
- 默认允许任意网页获得本地高权限桥接能力。

### 验收

- 两个 worktree 使用不同端口时，Preview 不会混淆来源。
- 页面刷新、服务重启和 session 关闭后的状态清楚可解释。
- 截图、URL 和错误摘要可以复制或发送到对应真实 Agent PTY。
- 不可信网页无法调用 Tunara 的本地高权限命令。
- Preview 崩溃或页面卡死不影响 PTY 和主窗口。

## Phase 4：Agent Attention 与交接

### 目标

让 Tunara 回答“谁正在做什么、谁需要我、完成后改变了什么”，而不成为 Agent 平台。

### 范围

- 统一展示 `running / waiting / done / failed / resumable / unknown`。
- 状态必须带来源和可信度：hook、进程、shell integration 或启发式画面识别。
- 点击状态回到对应真实 PTY。
- Agent 完成时汇总 changed files、Git diff 入口、测试证据和最近输出。
- 将 Preview 截图、console error、文件路径和选中文本送入对应 PTY 输入区。
- 支持用户明确触发的单 Agent 启动；启动命令完整可见并运行在真实 PTY。
- 支持已有 Agent session 的恢复命令填入或执行前确认。

### Agent Event Timeline

Agent Attention 需要一条本地、持久、可分页的事件基础设施，但不建设聊天壳。Timeline 统一承载用户输入、Agent 状态、输出摘要、工具调用、文件变化、测试结果、确认请求、Preview 证据和 Journal 引用。

- Rust 侧负责事件接收、顺序、持久化和游标分页；前端 store 只保存当前视图、游标、未读数和正在流式更新的事件。
- 历史使用 append-only 本地存储；事件 header 与大型 payload 分离，列表默认只读取轻量摘要。
- React 使用支持动态高度的虚拟列表，只渲染 viewport 和少量 overscan，不为 10,000 条事件创建 10,000 个 DOM 节点。
- 流式 token 按帧或短时间窗口合并，只更新当前 streaming event；完成后一次固化，不重渲染历史事件。
- Markdown、代码高亮、diff、大型工具输出和图片进入 viewport 或用户展开时才解析、读取和解码。
- 向上分页时保持滚动锚点；用户在底部时自动跟随，上滚后不抢夺滚动位置。
- 搜索和筛选在持久层或轻量索引上执行，不要求先把完整历史加载进内存。
- Timeline 默认展示关键转折和摘要；完整细粒度历史可以搜索和展开，但不让用户面对无限聊天墙。
- Mobile Companion 默认只接收必要事件摘要；Task Journal 只引用用户确认保留的证据，不复制完整 Timeline。

### 非范围

- Tunara 自己调用模型或维护对话协议。
- 根据启发式状态自动提交、删除 worktree 或关闭进程。
- 自动拆解任务、批量启动或多 Agent 自主协调。
- 以聊天产品为中心的 composer、conversation ownership 或模型 transcript。
- 默认将完整 PTY scrollback 等同于 Agent Timeline。

### 验收

- 多 worktree、多 Agent 场景下状态归属准确。
- Hook 缺失、版本变化或状态冲突时显示 `unknown`，不制造虚假确定性。
- 用户可以从完成提醒在两步内到达 diff 或真实终端。
- 发送给 Agent 的内容在进入 PTY 前可见、可编辑、可取消。
- 不支持的 Agent 仍然作为普通终端正常使用。
- 10,000 条历史事件下，打开、滚动、搜索、流式追加和切换 task 不随 DOM 数量线性退化。
- Timeline 持久层损坏、关闭或迁移失败时，真实 PTY 和普通终端会话仍然可用。

## Phase 5：受控 Worktree 生命周期

### 目标

在 Phase 1 的只读模型稳定后，补齐并行任务工作区的安全创建和清理。

### 范围

- 从现有 repository 创建 linked worktree。
- 明确选择新分支、已有分支和 base reference。
- 创建成功后打开对应 workspace 和真实终端。
- 可选地填入用户选择的启动命令或单 Agent 命令，不静默执行复杂工作流。
- 删除前检查 dirty、未推送提交、运行进程和关联 Preview。
- 默认只删除 worktree，不删除 Git branch。
- 支持比较两个 worktree 的状态和 diff 基线。

### 非范围

- 自动 merge、rebase、冲突解决和分支删除。
- 根据 Agent 完成状态自动清理 worktree。

### 验收

- dirty worktree 默认拒绝删除。
- 强制删除需要明确说明将丢失的内容。
- 删除 worktree 后分支默认保留。
- 创建或删除中途失败时，Git 元数据与 UI 状态可以重新扫描恢复。
- SSH worktree 操作遵循相同安全语义，并明确展示执行主机。

## Phase 6：Mobile Companion 远程陪伴

### 目标

让用户离开电脑后仍能在手机上查看开发进展、发现需要人工介入的 Agent，并完成少量透明、低风险的操作。

本阶段定义为“远程陪伴”，不是“远程接管”：手机首先是 workspace 和 Agent attention 的观察端，其次是有限的介入端，最后才可能提供临时、受控的 PTY 逃生入口。

### 依赖

- 依赖 Phase 1 的稳定 workspace/worktree identity。
- 依赖 Phase 4 的结构化 Agent Attention 和状态来源可信度。
- Preview 截图和浏览器错误依赖 Phase 3，缺失时独立降级。
- 不依赖 Phase 5 的 worktree 写操作；只读 Companion 可以先于 Phase 5 交付。

### Level 1：只读进展

- 展示已配对 Mac 的在线、离线和最后活动时间。
- 展示 repository、worktree、workspace、session 和 Agent 列表。
- 展示 Agent 的 `running / waiting / done / failed / resumable / unknown`。
- 展示任务目标、持续时间、最近输出摘要和状态来源。
- 展示 changed files、diff 统计、测试结果和 Preview 截图。
- 对 Agent 等待、完成、失败和长任务提供通知。
- 锁屏通知默认只显示最小状态，不包含终端输出、diff 或项目秘密。

### Level 2：低风险介入

- 向等待中的 Agent 发送一条用户可见、可编辑、可取消的文本。
- 回答 Agent 发出的明确确认问题。
- 请求刷新最近输出、diff、测试结果或 Preview 截图。
- 触发用户预先定义并明确授权的安全动作，例如重新运行测试。
- 请求填入或执行 Agent resume 命令；执行前显示设备、workspace、worktree 和真实命令。
- 将事项标记为稍后处理、静音或重新提醒。

### Level 3：临时受控 PTY

- 仅作为紧急逃生口，不作为手机端主要工作模式。
- 默认只读；写入前必须显式进入控制模式。
- 桌面端明确显示手机正在查看或控制哪个 session。
- 同一 PTY 同时只允许一个交互控制者，桌面端可以立即抢回控制权。
- 控制授权短时有效并自动过期；网络断开后立即回到只读。
- 高风险命令在发送前再次确认，不把手机输入静默写入 shell。

### 权限模型

设备配对后按能力授权，不提供单一的“远程控制”总开关：

- 查看 workspace 和 Agent 状态。
- 查看最近终端输出。
- 查看 diff 和 changed files。
- 查看 Preview 截图和错误摘要。
- 向 Agent 发送文本。
- 执行预设动作。
- 写入真实 PTY。
- 访问本地 session。
- 访问 SSH session。

权限默认最小化，可以按设备随时撤销。手机丢失后，用户必须能够在 Mac 上立即撤销设备密钥和所有活动连接。

### 连接架构

Mac 上的 Tunara 始终是 workspace、PTY、Agent 和 worktree 状态的唯一事实源：

```text
Tunara Desktop
├── PTY / Agent / Worktree / Preview
├── Companion Gateway
│   ├── identity and capability check
│   ├── event projection
│   ├── command validation
│   └── audit trail
└── outbound encrypted connection
         ↓
Companion Client
├── status and notifications
├── diff / preview inspection
└── explicitly authorized actions
```

个人版优先采用局域网或用户自有私网，例如 Tailscale，并通过二维码完成设备配对和密钥交换。首版不要求产品账号。

若以后需要跨网络 relay：

- Mac 主动建立出站连接，不要求公网开放本地端口。
- Relay 只转发端到端加密消息，不能读取终端、diff、截图或命令。
- 推送服务只携带唤醒和最小状态，不携带敏感正文。
- Relay 不成为 workspace 数据库，离线历史默认保留在用户设备。
- Relay、账号、订阅和云基础设施必须经过单独产品决策，不能成为 Level 1 的隐藏前置条件。

### Companion Gateway 边界

- 手机不能直接连接内部 Tauri IPC、Agent hook socket 或 Herdr socket。
- Gateway 只暴露稳定、版本化、按能力授权的领域事件和动作。
- 移动端复用桌面端的 workspace/session identity，不维护第二套事实源。
- 所有写动作都记录设备、用户意图、目标 session/worktree、时间和结果。
- 事件历史有明确数量、时间和大小上限，不默认复制完整 scrollback。
- 协议不兼容、状态冲突或桌面端锁定时，写能力关闭并降级为只读。

### 安全与隐私

- 设备使用独立密钥，不复用 SSH 私钥、Git 凭证或 Agent token。
- 配对需要在 Mac 上明确确认，并展示双方设备指纹。
- 所有连接端到端加密，并防止旧消息重放。
- 终端输出、diff、截图和 Preview 登录态默认按敏感数据处理。
- 锁屏通知隐藏项目名和正文，用户可以显式放宽。
- 不自动同步 shell history、环境变量、剪贴板、SSH 私钥或整个工作区文件。
- Preview 截图由用户或明确策略触发，不持续录屏。
- PTY 写入、预设动作和确认回答进入本地审计记录；敏感正文可以不记录。
- 手机端需要系统设备锁、生物识别和本地加密存储；不满足时不开放写权限。

### Herdr 关系

Herdr 可以作为 Companion 的实验 provider，但手机不能直接拥有 Herdr socket 权限：

```text
Companion Client
  -> Tunara Companion Gateway
  -> capability and command validation
  -> Native Tunara session or Herdr provider
```

Tunara 负责权限、身份、审计和用户确认；Herdr 只提供 workspace/pane/Agent 状态及 `read / send / wait`。Herdr 不存在或协议不兼容时，Companion 的原生能力不受影响。

### 非范围

- 完整远程桌面和桌面画面串流。
- 手机端多文件编辑、冲突解决和完整 Git 操作。
- 手机端长期替代桌面终端或成熟 SSH/mosh 客户端。
- 自动提交、merge、rebase、发布或删除 worktree。
- 无确认执行任意 shell 命令。
- 将手机端扩展为模型聊天或多 Agent 调度平台。
- 默认建立云账号、云工作区或服务端可读的数据同步。

### 验收

- 未配对设备无法发现敏感状态或调用动作。
- Mac 离线、休眠、切网和重连时状态清楚，不重复执行写命令。
- 多 repository/worktree/Agent 下，通知和操作始终指向正确目标。
- 锁屏通知默认不泄露项目、终端输出、diff 或 Prompt 内容。
- 撤销设备后，已有连接和旧凭证立即失效。
- Level 1 可以在没有云账号和公网入站端口的条件下使用。
- Level 2 的写动作在发送前可见，并能在桌面端追溯来源和结果。
- Level 3 断线、超时或桌面抢占后不再接受手机输入。
- Gateway 故障、关闭或版本不兼容时，桌面终端完全正常。
- 如果用户主要通过手机长时间操作 shell，停止扩展 Level 3，转向与成熟工具协作。

### 最小验证实验

首版不做原生 iOS App，也不做公网 relay：

1. 桌面端提供只读、版本化的本机 Companion API。
2. 只投影 workspace、Agent attention、最近输出摘要和 diff 统计。
3. 使用手机网页/PWA，通过同一局域网或 Tailscale 访问。
4. 使用二维码配对，默认只授予只读权限。
5. 验证真实离桌场景：Agent 完成、等待确认、测试失败和长任务进展。
6. 确认只读查看形成稳定使用后，再增加单条 Agent 回复。
7. 原生 iOS、系统推送、relay 和 PTY 控制分别通过新的决策门。

### 前提失效条件

本阶段假设离开电脑后的主要需求是查看状态、发现阻塞并进行短回复。如果真实需求主要是长时间操作 shell、编辑代码或解决复杂冲突，应停止扩展 Companion 控制能力，转而与成熟 SSH/mosh/tmux 客户端协作。

## Phase 7：Task Journal 与 Workflow Recipe

### 目标

让每次开发不只完成当前任务，还能为下一次开发留下可恢复、可检索、可提炼的经验，闭合个人加速飞轮：

```text
执行 -> 观察 -> 验证 -> 记录 -> 提炼 -> 下次复用
```

Task Journal 记录一次任务真实发生了什么；Workflow Recipe 只承载从多次成功实践中提炼出的可复用流程。两者必须分开，避免未经验证的偶然操作直接变成自动化规则。

### Task Journal 范围

- 每个 task/workspace 可选择建立一份结构化记录。
- 记录任务目标、repository、worktree、session 和关联 Agent。
- 记录用户确认保留的关键命令、changed files、测试/构建结果和 Preview 截图。
- 记录重要失败、重试、最终结果、遗留事项和用户结论。
- 支持从 Agent 完成摘要、Review 和 Preview 中引用证据，不复制完整 transcript 或 scrollback。
- 支持任务结束时生成可编辑的 handoff：目标、完成内容、验证证据、已知问题和下一步。
- 用户回到 workspace 时，可以看到上次任务停在哪里以及哪些事项未完成。
- Journal 默认本地保存，可导出为稳定、可读的 Markdown/JSON；删除 workspace 时不强制删除 Journal。

### Workflow Recipe 范围

- Recipe 明确定义适用项目类型、触发条件、步骤、人工确认点、验证条件、失败处理和完成证据。
- 每一步显示真实命令和目标 workspace；默认填入或逐步确认，不隐藏执行。
- 区分项目专属 Recipe 与跨项目通用 Recipe。
- 只有重复成功或由用户明确批准的流程，才能从 Journal 提升为 Recipe。
- Recipe 执行结果回写新的 Journal，保留哪些步骤通过、失败、跳过及原因。
- 支持 dry-run/preview，先展示将执行的命令、写操作和外部依赖。
- Recipe 中涉及文件写入、worktree、SSH 或 Companion 的动作，复用统一 Action 风险和确认模型。

### 非范围

- 默认记录完整终端历史、Agent transcript、环境变量或 secrets。
- 根据一次成功记录自动生成并启用 Recipe。
- 隐藏式后台自动化、无人确认的发布流水线或多 Agent 自主编排。
- 把项目私有路径、凭证、机器专属配置自动提升为全局规则。
- 用 Journal 替代项目文档、Git 历史或正式 issue tracker。

### 验收

- 用户能从完成任务生成一份不依赖聊天上下文的可读 handoff。
- Journal 中的命令、文件、测试和截图都能追溯到正确 workspace/worktree。
- 默认记录不包含完整 scrollback、环境变量或明显 secrets。
- 应用重启后可以恢复未完成任务，旧 Journal schema 可以迁移或只读打开。
- Recipe 预览与实际执行步骤一致；失败后能从明确步骤恢复，而不是整条重跑。
- 删除 Recipe 不影响已有 Journal；禁用 Journal 不影响 Terminal、Agent、Preview 和 Review。
- 连续使用后，至少有一条高频流程因 Recipe 明显减少重复判断，否则停止扩展自动化能力。

### 推荐起点

先做手动、轻量的 Task Journal，不做自动提炼：

1. 用户为当前 workspace 写一句任务目标。
2. Tunara 引用已有 changed files、测试结果和 Preview 证据。
3. 任务结束时生成可编辑 Markdown handoff。
4. 用户明确选择哪些结论进入长期记录。
5. 累积真实使用后，再设计 Recipe schema 和提升流程。

## 8. Herdr 实验支线

Herdr 用于验证持久 session、Agent attention 和 worktree 控制模型，不进入主产品关键路径。

### 已验证事实

- Herdr 0.7.3 可通过 Homebrew 安装并在 macOS 启动。
- Server 真正持有 PTY；TUI detach 后 shell 进程继续运行。
- CLI/API 能读取 workspace、pane、process、Agent 和 worktree 状态。
- CLI 可以向 pane 执行命令、读取输出并等待匹配结果。
- Worktree 创建会建立独立 workspace。
- Dirty worktree 在未指定 force 时拒绝删除。
- 删除 worktree 后 Git branch 默认保留。
- `herdr api schema --json` 提供协议 Schema。

### 实验目标

先实现一个只读、可移除的 Herdr provider spike，回答：

1. Tunara 能否稳定发现 Herdr server 和协议版本？
2. CLI JSON 是否足以展示 workspace、worktree、pane 和 Agent attention？
3. 点击 Herdr workspace 后，能否在真实 Tunara PTY 中安全 attach？
4. Herdr 和 Tunara 同时存在时，谁是 session/PTY 状态的唯一事实源？
5. 嵌套模式下键位、鼠标、滚动、复制、resize、WebGL 和中文输入法是否可接受？

### 约束

- 第一版只读，不安装 Herdr Agent integrations。
- 不静默修改 `~/.codex`、`~/.claude` 或其他全局 Agent 配置。
- 不解析 Herdr 私有状态文件；只使用公开 CLI JSON 或版本化 Socket API。
- 不复制、链接或 vendor Herdr 的 AGPL 源码。
- Herdr 不存在、未运行或协议不兼容时，Tunara 必须完全正常工作。
- Spike 不承诺进入正式产品；验证失败时只保留学到的模型和安全规则。

### 成功门槛

- 状态来源稳定，协议不兼容可以清楚降级。
- 嵌套 PTY 体验没有不可接受的输入、显示或控制冲突。
- Provider 能带来明显价值，而不是重复 Tunara 已有 session UI。
- 不需要两个系统同时拥有同一个 PTY 的控制权。

## 9. 共享数据模型方向

后续设计应围绕稳定 ID 和来源关系，而不是把路径字符串当作唯一身份：

```text
RepositoryRef
  id
  local_or_remote
  host
  common_git_dir

WorktreeRef
  id
  repository_id
  checkout_path
  branch_or_detached_head
  dirty_summary

WorkspaceRef
  id
  worktree_id
  sessions[]
  previews[]

SessionRef
  id
  workspace_id
  terminal_id
  agent_evidence

AgentEventRef
  id
  task_id
  workspace_id
  session_id
  kind
  status
  created_at
  summary
  payload_ref
  sensitivity

EventPayloadRef
  event_id
  format
  byte_size
  storage_ref

PreviewRef
  id
  workspace_id
  source_session_id
  url
  connection_mode

CompanionDeviceRef
  id
  public_key
  capabilities[]
  revoked_at

CompanionEventRef
  id
  workspace_id
  session_id
  kind
  sensitivity

CompanionActionRef
  id
  device_id
  target_session_id
  capability
  intent
  result

TaskJournalRef
  id
  workspace_id
  goal
  evidence_refs[]
  outcome
  next_steps[]

WorkflowRecipeRef
  id
  scope
  prerequisites[]
  steps[]
  verification[]
  failure_policy

SurfaceRef
  id
  kind
  workspace_id
  source_session_id
  lifecycle
  persistence
  capabilities[]
  sensitivity

ActionRef
  id
  actor
  target
  intent
  risk
  requires_confirmation
  idempotency_key
  result
```

这只是领域关系，不是要求一次性迁移现有 store。每个阶段应只引入它实际需要的最小字段，并提供旧持久化数据的迁移与降级路径。

## 10. Surface 生命周期与事实源

每种 surface 在实现前必须明确所有权和生命周期，避免 Terminal、Preview、Editor、Companion 或外部 provider 同时维护互相冲突的状态。

### 统一规则

- 每个 surface 必须属于一个 workspace，并使用稳定 ID。
- 创建时记录来源；移动、关闭、恢复和删除都有明确语义。
- workspace 关闭、session 退出、worktree 删除和应用重启时，分别定义 surface 行为。
- Surface 可以持有视图状态，不能复制底层工具的权威状态。
- 移动端只接收 surface 投影，不拥有桌面 surface。

### 事实源

- Terminal 的运行状态由实际 PTY/runtime 持有。
- Files 和 Editor 的内容由真实文件系统持有，未保存缓冲区只属于 Editor surface。
- Review 由真实 Git repository/worktree 状态派生。
- Preview 的页面由目标 URL/进程持有，Tunara 只保存来源和视图状态。
- Agent 状态是带证据和可信度的派生状态；无法确认时为 `unknown`。
- Herdr 被启用时，Herdr server 是其 pane/PTY 的事实源，Tunara 只作为 provider client。
- Task Journal 是用户确认后的任务记录，不反向覆盖 Git、文件或终端事实。

### 生命周期门禁

- Worktree 删除前列出关联 Terminal、Preview、Editor、Agent 和未完成 Journal。
- Session 退出后，Preview 可以保留但必须显示来源已停止。
- 未保存编辑缓冲区不能因 workspace 关闭或应用升级静默丢失。
- 外部 provider 不可用时，保留可解释的最后状态，但禁止继续写入。
- 新 surface 必须能独立关闭或禁用，不能阻塞 Terminal 启动和恢复。

## 11. 统一 Action 与风险模型

桌面、手机、Recipe、Agent 和 Herdr provider 触发的动作使用同一语义：

```text
Action
  actor
  target
  intent
  command_or_operation
  risk
  requires_confirmation
  idempotency_key
  started_at
  result
```

### 风险级别

- `observe`：读取状态，不改变外部系统。
- `prepare`：把命令或文本放入可编辑区域，但不执行。
- `execute-safe`：执行用户预先授权、可重复、低风险的动作。
- `execute-sensitive`：写 PTY、保存文件、创建/删除 worktree 或访问敏感 SSH session。
- `destructive`：可能丢失数据、改变远端共享状态或不可轻易撤回；必须在桌面端明确确认，默认不向 Companion 和 Recipe 开放。

### 规则

- “填入”和“执行”是两个不同 Action，不能共用模糊按钮或事件。
- 每个写动作必须标明 actor、设备、目标 workspace/worktree 和真实操作。
- 可重试动作带 idempotency key，断线重连不能重复执行。
- Action 失败必须报告是否产生部分外部状态以及如何恢复。
- 启发式 Agent 状态不能自动触发 sensitive 或 destructive Action。
- 审计记录允许隐藏敏感正文，但必须保留动作类型、目标、时间和结果。

## 12. 本地 Dogfood 指标

指标用于判断个人飞轮是否成立，不用于遥测或增长分析：

- 每周实际使用 Tunara 的天数和 workspace 数量。
- 从 Agent attention 出现到用户处理的时间。
- 外跳到编辑器、浏览器和远程工具的次数及原因。
- Markdown、轻编辑、Preview 和 worktree 能力的实际使用频率。
- 从手机打开通知、查看进展和发送有效回复的次数。
- Journal 完成率、再次打开率和 Recipe 复用次数。
- Timeline 打开时间、滚动帧时间、流式事件合并率和历史查询延迟。
- 新功能加入前后的启动时间、内存、输入延迟和崩溃情况。

所有指标默认只保存在本机，用户可以查看、导出、关闭和清空。数据不上传，不含命令正文、文件内容、Prompt、diff 或 secrets。

每个 Phase 在开工前设定继续条件。例如：只读 Preview 被稳定使用后才投入更完整的浏览器能力；只读 Companion 形成真实离桌使用后才做原生 iOS 和写操作；至少一条 Recipe 被重复有效使用后才扩展自动化系统。

“最快”“无卡顿”等比较性产品表述必须由公开、可复现的统一 benchmark 支持。在没有与直接竞品使用同一数据、设备和操作路径对比前，只描述已经测得的规模、延迟、内存和帧表现，不把主观体验写成绝对领先声明。

## 13. 发布、迁移与撤回策略

- 每个 Phase 通过独立 capability/feature flag 交付，可以单独关闭。
- 新 surface 和网络服务不进入首屏关键路径，默认按需启动。
- 新持久化 schema 提供向前迁移、旧数据只读或明确降级路径。
- 旧版本无法理解的新数据不能破坏原有 workspace 快照。
- Preview、Editor、Companion、Journal 和 Herdr provider 崩溃时可独立隔离。
- Companion Gateway 默认关闭，由用户主动开启和配对。
- Herdr provider 完全可卸载，不留下对 Terminal 的运行依赖。
- 每个能力定义本地数据位置、导出方式、删除方式和保留策略。
- 使用率不足、维护成本过高或破坏 Terminal 核心体验的能力应能撤回，不被历史数据绑架。
- 发布前验证 capability 从开启到关闭再开启的数据兼容和恢复行为。

## 14. 跨阶段质量门禁

每个阶段交付前至少验证：

### 自动验证

- TypeScript 类型检查。
- Node/Rust 单元和回归测试。
- 前端 production build。
- Tauri bundle 构建。
- 持久化 schema 迁移和旧快照恢复测试。
- 本地/SSH 权限边界与 IPC 参数验证。

### 真实运行验证

- 真实 macOS bundle，而不只是在浏览器或 dev server 中验证。
- 本地 zsh/bash 与至少一种 SSH 环境。
- 窄窗口、分屏、应用后台恢复和重启恢复。
- 大目录、大文件、长输出和断网/重连。
- 中文输入、复制粘贴、鼠标滚动和快捷键冲突。
- 多 worktree、多 Agent、端口冲突和外部文件修改。

### 性能预算

- 新增 surface 不阻塞 PTY 输入和输出处理。
- Repository/worktree 扫描必须缓存、去重、取消过期请求。
- Preview、Markdown 和编辑器按需加载，不进入首屏关键路径。
- Agent 状态刷新以事件为主、低频回查为辅，避免高频轮询所有 session。
- Companion 事件投影不读取完整 scrollback，使用严格的数量、大小和保留时间预算。
- Companion Gateway 和网络重连不能阻塞或反压本地 PTY 事件循环。

### Agent Event Timeline 性能门禁

使用可重复生成的合成数据和真实 Agent 样本验证：

- 10,000 条普通事件。
- 1,000 个 Markdown 代码块。
- 500 条工具调用。
- 200 个 diff 摘要。
- 100 张 Preview 缩略图。
- 一条持续高速增长的流式事件。

必须覆盖首次打开、快速滚动、向上分页、搜索、展开大型代码块、流式追加、切换 task、应用重启恢复和后台运行后回前台。

验收要求：

- 首屏按页读取最近事件，不预读 10,000 条完整 payload。
- DOM 节点数量由 viewport 和 overscan 决定，不随总事件数线性增长。
- 新 token 到达时不重渲染历史事件，也不阻塞 PTY 输出。
- 滚动期间没有肉眼可见的持续掉帧或长时间主线程阻塞。
- 切换 task、搜索和恢复不会因历史规模线性变慢。
- Timeline 内存使用主要由当前页、缓存预算和可见富内容决定。
- 测试必须在真实 macOS bundle 中记录帧时间、内存和交互录屏，不能只依赖单元测试。

### Terminal WebGL 乱码与高输出稳定性

#### 已定位症状与当前判断

已观察到 Agent 大量输出后终端字形乱码，调整终端或窗口大小后立即恢复。该现象优先指向 xterm WebGL glyph texture atlas 失效，而不是 PTY/UTF-8 内容损坏：resize 会执行 `fit()` 并重建 texture atlas，而底层输出缓冲并未被修改。

当前实现已在以下路径调用 `WebglAddon.clearTextureAtlas()`：

- 终端尺寸发生变化并完成 `fit()` 后。
- 窗口重新 focus 或从不可见恢复后。
- 字体、字号、主题、光标、连字等会改变字形或颜色的配置变化后。
- WebGL context loss 时释放损坏 renderer，并允许降级。

现有回归测试只证明这些触发路径会调用 atlas rebuild，尚未证明真实 WKWebView、长时间 Agent 输出和 GPU context 压力下不会再次乱码。因此该问题状态是“已有针对性加固，仍需真实压力验证”，不能标记为彻底解决。

#### 完善目标

- 建立确定性的高输出 fixture，覆盖 ANSI 颜色、粗体、连字、CJK、emoji、宽字符、组合字符、光标移动、清屏和 alternate screen。
- 分别压测本地 PTY、SSH、前台、后台、窗口遮挡、睡眠唤醒、主题切换和分屏 resize。
- 记录 WebGL context loss、atlas rebuild 次数、renderer 降级、输出 backlog、帧时间和内存，不记录终端正文。
- Context loss 后必须自动切换到可用 renderer；不能停留在损坏的 WebGL 画面等待用户 resize。
- 提供可发现的“重置终端渲染器”诊断动作，作为逃生口而不是长期修复方案。
- 不使用固定周期 `clearTextureAtlas()` 掩盖根因；只有明确的失效信号或安全生命周期事件才触发 rebuild。
- DOM renderer fallback 必须保持选择、复制、搜索、IME 和基本颜色正确，性能下降可以解释但不能显示损坏内容。
- 输出批处理和 backlog 保护不能切断 UTF-8 多字节序列、ANSI 控制序列或 OSC payload；丢弃策略必须按完整解码/写入边界处理。

#### 回归与验收

- 真实 macOS bundle 连续运行 Agent 或合成输出至少 30 分钟，期间反复遮挡、切换 workspace、分屏和 resize，无可见字形错位或乱码。
- 50–200 MiB 混合输出后，屏幕内容与 DOM renderer/reference capture 在关键检查点一致。
- 发生模拟/真实 context loss 后，无需用户调整窗口即可恢复可读画面。
- Resize 仍能重建 atlas，但不再是唯一恢复路径。
- 回归测试必须覆盖 atlas rebuild、context loss fallback、UTF-8/ANSI chunk boundary 和高输出后继续交互。
- 修复后必须在真实 release bundle 验证；dev WebView 或单元测试通过不代表完成。

### Code Agent 终端界面主动适配

Tunara 可以主动适配 Claude Code、Codex、Pi、OpenCode、Aider 等终端 Agent，但适配目标是提供正确、稳定、宽敞的终端能力，不解析并重绘 Agent 私有 UI。

#### 终端协议兼容

- 正确支持 alternate screen、光标保存/恢复、bracketed paste、focus reporting、mouse tracking、OSC 8、OSC 52、True Color 和常见 DEC mode。
- 保证 Unicode 宽度、CJK、emoji、组合字符、连字和 IME composition 在普通 shell 与 Agent TUI 中一致。
- Agent 进入 alternate screen 时，命令块、sticky chrome、搜索 overlay 和自定义快捷键不能覆盖或污染终端 cell。
- Agent 离开 alternate screen 后，普通 scrollback、选择、复制和命令块行为必须恢复。
- 不把 alternate screen 当作可靠历史；长期事件和交接通过 hook/Agent Event Timeline 获得，不解析私有 stdout 布局。

#### 几何与布局适配

- 为 Agent TUI 定义建议最小 cols/rows；窗口过窄时优先提示或建议进入 Focus Mode，而不是静默挤坏界面。
- 侧栏、Review、Files 和 Preview 的展开不能让终端低于可用几何下限；用户仍可显式覆盖。
- Agent TUI 运行期间 resize 使用最后值合并，避免高频中间尺寸造成反复重排。
- 分屏、面板展开、全屏和 workspace 切换后，PTY rows/cols 与 xterm viewport 必须一致。
- 不为特定 Agent 硬编码永久布局；使用 capability、alternate-screen 状态和实际 terminal geometry 决策。

#### 输入与快捷键适配

- 建立 Tunara 快捷键与 Agent TUI 快捷键冲突表；终端获得焦点时，未明确归 Tunara 的按键优先透传。
- Paste protection 区分普通 shell 自动执行风险和 Agent prompt 文本输入，不破坏 bracketed paste。
- `Esc`、`Ctrl+C`、`Ctrl+R`、方向键、Tab、Shift+Tab 和常见 multi-line input 在支持的 Agent 中逐项验证。
- 手机 Companion 或外部 provider 写入 Agent 时复用 `prepare`/`execute` 区分，文本进入 PTY 前保持可见、可取消。

#### Agent-aware 辅助能力

- Agent 名称、running/waiting/done/failed/unknown、文件变化和确认请求显示在终端外层，不覆盖 Agent 自己的 TUI。
- Agent 请求人工处理时可以聚焦真实 PTY，并保留用户当前滚动位置和输入状态。
- 从终端识别 localhost URL、文件路径和错误位置，提供 Preview、Files、Review 跳转，但不修改 Agent 输出。
- 提供用户明确触发的 Focus Mode 建议、恢复命令、最近结果摘要和变更入口。
- Hook 或 shell integration 不可用时显示 capability/可信度，不能把画面启发式误报成权威状态。
- 对 tmux、Herdr、SSH 和普通本地 PTY 保持同一 Agent UI 语义，并明确谁拥有 resize、scrollback 和 session lifecycle。

#### Agent 兼容矩阵

每个正式支持的 Agent 至少验证：启动、首次权限提示、多行输入、工具调用、高输出、等待确认、完成、失败、resume、alternate screen、窗口 resize、分屏、后台恢复、复制粘贴和退出。

矩阵至少覆盖：

- Claude Code。
- Codex。
- Pi / Oh My Pi。
- OpenCode。
- Aider。
- 一个不受 hook 支持的普通 TUI，证明未知 Agent 仍可正确使用。

每个 Agent 分别在本地 PTY 和 SSH 验证；tmux/Herdr provider 进入正式范围后再增加嵌套矩阵。Agent 版本升级后优先跑兼容 smoke，不根据品牌名称假设 UI 协议保持不变。

### SSH 完整性与性能门禁

SSH 后续扩展必须先修复高吞吐和控制权问题，再进入远程编辑、Preview 和 worktree 写操作。

#### P0 性能与控制权

- SSH 输入从“消息数上限”改为字节预算；大粘贴分块，RSS 增量受控。
- Close 使用独立 cancellation/高优先级路径，输入队列塞满时仍能立即断开。
- Resize 使用 latest-value 合并，不排在历史输入之后。
- SSH 输出按 4–16ms 或 64–256KiB 有界批处理，减少逐包 Base64 和 IPC 事件风暴。
- 远程文本预览只读取 preview cap + 探测字节，不为 256KiB 预览下载最多 10MiB。
- 为本地/SSH 共用输出路径验证 UTF-8、ANSI、OSC 边界和 backlog overflow 语义。

#### P1 并发、RTT 与恢复

- 每个 SSH session 对搜索、Git、diff、文件预览和后台刷新设置 inspection semaphore 与优先级，交互 shell 始终最高。
- 高 RTT 目录浏览支持 channel 复用、缓存或增量首屏，避免每次导航承担不必要的多轮往返。
- known_hosts 大文件解析移出 async worker，并按 path/mtime/size 缓存。
- exec 返回结构化 `bytes/truncated/exit_status/stderr`，解析器不接受静默截断结果。
- 需要 password/passphrase 的恢复 session 进入“等待认证”，不在应用启动时先进行一次注定失败的自动连接。
- 重连候选配置在连接 ready 后才提交；失败时保留旧 endpoint 和可重试上下文。
- 文件浏览、搜索和预览区分断线、权限、超时、能力缺失并提供重连/重试/复制诊断。

#### P1/P2 功能闭环

- 支持 ProxyJump 和 keyboard-interactive；不支持的 OpenSSH 配置项必须明确展示，不能假装完整导入。
- 远程编辑使用 fingerprint 冲突检测、同目录临时文件、权限保留、原子 rename 和失败清理。
- 远程 Preview 使用用户确认的 `127.0.0.1` local forwarding，并绑定来源 SSH session/worktree。
- 展示远程 capability/health：SFTP、Git、grep、shell integration、Agent hook 和持久 runtime。
- 长任务恢复优先接入 tmux/Herdr/mosh/Agent resume，不声称普通 SSH 连接拥有进程持久化语义。
- 远程 worktree create/remove 复用 dirty、未推送提交、运行进程和执行主机确认门禁。

#### SSH Benchmark

- 50–200MiB 连续输出：IPC 数、CPU、RSS、p95 frame time、输入回显和关闭延迟。
- 100MiB 粘贴：输入字节预算、RSS 峰值、Close 响应和最终 resize 正确性。
- 100/200ms RTT：连接、连续目录导航、preview、grep、diff 和取消生效时间。
- 10,000 项目录、10MiB 文本、100MiB 下载和多个并发 inspection 请求。
- 网络切换、丢包、断线、睡眠唤醒、SFTP timeout 和重连。
- 所有基准使用真实或可控 sshd/russh harness，并在真实 macOS bundle 中记录。

### Companion 安全门禁

- 配对、撤销、密钥轮换、重放防护和权限降级测试。
- 手机、Mac 和可选 Relay 之间的端到端加密与协议版本兼容测试。
- 锁屏通知、日志、崩溃报告和审计记录的敏感信息泄漏测试。
- 重复投递、乱序、断线重连和跨 worktree 目标混淆测试。
- 桌面锁定、设备撤销、权限收回和控制权抢占后的拒绝写入测试。

## 15. 决策门

每完成一个 Phase，再根据真实个人使用做下一阶段决策：

- 是否减少了有意义的外部切换？
- 是否形成了新的高频闭环，而不只是增加入口？
- 是否保持了终端的速度、稳定和清晰感？
- 新能力是否开始要求另一套复杂状态源？
- 用户是否仍然知道命令在哪里运行、文件在哪里变化、结果属于哪个 worktree？
- 是否产生了可复用经验，还是只增加了新的操作界面？
- 本地 Dogfood 指标是否达到该 Phase 预先设定的继续条件？

如果一个方向需要 Tunara 隐藏真实工具、接管用户决策或维护第二套事实源，应停止扩张并重新设计集成边界。

Mobile Companion 还需要独立回答：用户真正需要的是短暂监督和解除阻塞，还是完整远程开发。如果是后者，优先与成熟 SSH/mosh/tmux 客户端协作，而不是扩大 Tunara 的移动控制面。

Task Journal 与 Recipe 还需要独立回答：记录是否真的被再次使用，流程是否真的减少重复判断。如果记录长期无人回看或 Recipe 只执行一次，保持手动 Journal，不继续建设自动提炼系统。

## 16. 执行收敛与 Active Milestone

Goal 已经覆盖长期方向。进入开发后停止继续横向扩 scope，同一时间只允许一个 Active Milestone；其他阶段保持 planned、experimental 或 blocked，不以并行占位代码制造虚假进展。

### 固定交付顺序

```text
M0  Phase 1 真实验收
M1  Terminal + SSH 性能与乱码稳定性
M2  Markdown 阅读与单文件轻编辑
M3  Agent Event Store + Timeline
M4  Workspace-bound Browser Preview
M5  Agent Attention + Task Journal
M6  受控 Worktree 生命周期
M7  Mobile Companion 只读 PWA
```

Herdr、Workflow Recipe、原生 iOS、系统推送、公网 Relay 和手机 PTY 控制保持实验或后置状态，不与主线 Milestone 并行。

### 开工门禁

- M0 未完成真实 bundle、本地多 worktree、SSH、大量 session、窄窗/分屏、重启和中文路径验收前，不启动 M2–M7。
- M1 的高输出乱码、SSH 输出批处理、输入字节预算、Close/Resize 控制权和慢链路基准完成前，不把新的远程写入或富 surface 接入主路径。
- M3 先完成事件 append、持久化、分页、重启恢复和删除，再开发 10,000 条富 Timeline UI。
- M7 必须等 workspace identity 和 Agent Attention 事件稳定，且首版只做默认关闭、只读、局域网/Tailscale PWA。
- 任一 Milestone 未达到完成合同，保持未完成；不能因入口、占位 UI、一次 smoke 或版本发布自动进入下一阶段。

### Milestone 完成合同

每个 Milestone 开工前单独写一份短实施规格，另一个工程师或 Agent 应能据此执行而无需重新决定方向。规格必须包含：

- 唯一目标和用户价值。
- Scope 与明确 Non-scope。
- 依赖和现有能力复用点。
- 数据模型、公共接口、IPC、配置和持久化变化。
- 预计涉及文件；超过 8 个文件或新增服务时明确说明。
- Happy path、错误、取消、边界和恢复测试。
- 真实 macOS bundle 验收路径。
- 性能与资源预算。
- 安全、隐私和权限边界。
- Feature flag/capability、迁移、回滚和数据清理方式。
- 继续条件、停止条件和可撤回路径。

每个 Milestone 必须独立可合入、可使用、可关闭。后续 Milestone 永远不应成为前一阶段可用的前置条件。

### 基线性能报告

任何优化前先保存可复现基线，避免用主观“更快”代替证据。至少记录：

- 冷启动到窗口可见时间。
- 冷启动到首个 PTY 可输入时间。
- 普通终端输入和回显延迟。
- 50/200MiB 输出的 CPU、RSS、IPC 数和帧时间。
- 10 个并行 session 的内存、切换和后台恢复。
- WebGL context 数量、atlas rebuild、context loss 和 renderer fallback。
- SSH 100/200ms RTT 下的连接、目录、preview、grep、diff 和取消延迟。
- 大目录、大文件、长输出和网络恢复。
- Release bundle 大小与安装后启动结果。

基线标明硬件、macOS、Tunara commit、构建模式、数据 fixture、采样命令和原始结果。结果保存在仓库认可的 benchmark 报告或可重跑脚本中，不进入遥测系统。

### 当前 Active Milestone

M0 Phase 1 Workspace/Worktree、M1 Terminal + SSH 稳定性与 Phase 2 Markdown/单文件轻编辑均已完成。Phase 3 已按[Preview 安全规格](./PHASE3_PREVIEW_SOURCE_CONTRACT.md)建立来源身份、检测 allowlist、去重/stale 合同、隔离的 localhost WebView/navigation policy、opening/loading/ready/failed/closed/stale 的最小运行时状态与手动服务恢复闭环，以及可信 main Inspector 中的同源地址导航和原生前进/后退历史。缩放、viewport、截图、console/network、服务重启关联和 SSH tunnel 仍是未满足的 Phase 3 required gates；保持后置，不自动进入 Phase 4。

## 17. 推荐起点

从 Phase 1 的只读 Workspace/Worktree 感知开始，不先做编辑器、浏览器或 Herdr 正式集成。

第一个可交付切片：

1. 为当前本地 session 解析 repository common git dir 和 worktree checkout。
2. 在现有会话概览中展示 repository、worktree、branch 和 dirty 状态。
3. 发现同仓库其他 worktree，但只展示，不创建或删除。
4. 为现有 Git Review 和 File Explorer 附加明确的 worktree 来源。
5. 为非仓库、bare repo、detached HEAD、符号链接和失效 worktree 添加回归测试。

该切片独立有用，并为 Markdown 编辑、Preview、Agent attention 和 Worktree 生命周期提供统一上下文基础。

Mobile Companion 不与第一个切片并行开工。等 Phase 1 的 identity 和 Phase 4 的 attention 事件稳定后，先做局域网/Tailscale 下的只读 PWA 验证，再决定是否投入原生 iOS、系统推送和公网 relay。

Task Journal 可以在 Phase 1 identity 稳定后先做最小手动版本，但 Workflow Recipe 必须等真实 Journal 积累后再设计，不能凭空定义一套自动化语言。

## 18. 前提失效条件

这个 Goal 建立在一个关键前提上：Tunara 是用户长期使用的主开发入口，而不是偶尔打开的辅助终端。

如果真实使用表明用户仍主要在其他终端、IDE 或浏览器中工作，新增 surface 不会形成飞轮，反而会增加维护成本。此时应停止扩展内置能力，转而强化外部工具跳转、上下文传递和轻量集成。
