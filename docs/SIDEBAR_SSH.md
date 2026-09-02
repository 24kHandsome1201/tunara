# 左侧栏 SSH 适配规划

本文原是一份现状分析与优化提案。**阶段 A–D 已于 2026-08-16 落地**；用户可见合同以 [FEATURES.md](./FEATURES.md) 为准。下文保留设计动机与取舍，方便回顾为什么分组键从 `dir` 换成主机身份。

它对照当前代码，说明左侧栏今天如何对待 SSH，以及接下来应按什么顺序改。产品原则仍以 [GOAL.md](./GOAL.md) 为准；用户可见能力对照以 [FEATURES.md](./FEATURES.md) 为准。右侧栏职责边界见 [INSPECTOR_PANELS.md](./INSPECTOR_PANELS.md)：侧栏负责定位会话，Inspector 负责当前会话的只读上下文与轻量操作。

---

## 1. 产品判断

左侧栏是 **会话定位器**，不是主机管理器，也不是第二个 Inspector。

本地会话按工作目录分组，是 Tunara 和普通标签终端的差别。SSH 成为一等公民之后，这个模型不能原样套：远程会话的身份是 **主机 + 认证偏好**，cwd 只是该主机上的当前位置。侧栏要让人一眼分清「这是哪台机器上的哪几个壳」，而不是把 `user@host` 和 `/tmp` 两种完全不同的字符串塞进同一个 `dir` 字段里分组。

适配原则：

- **传输隔离。** 本地路径和远端路径即使字面相同，也绝不能分到同一组。
- **SSH 按主机聚，不按 cwd 聚。** `cd` / OSC 7 只改卡片副标题，不拆组、不合组。
- **侧栏只展示活会话。** 已保存主机制造连接，不占会话列表的主体。
- **动作跟文件系统走。** 本地组可以「在此目录新建终端 / 打开编辑器」；SSH 组对应「在此主机再开一个窗口」，绝不把远端路径交给本地 PTY 或本地编辑器。
- **连接异常留在现有动态层。** 重连、失败、可恢复已经由统一会话动态处理，不要在卡片上再做一套独立状态机。

明确不放进左侧栏：传输进度、端口转发、诊断、known_hosts、SFTP 树、Preview。这些继续留在 Inspector / 设置。

---

## 2. 当前结构（2026-08-16 起）

阶段 A–D 已落地。分组入口是 [`groupSessionsForSidebar`](../src/modules/session/sidebar-groups.ts)，组键是 `local:<dir>` / `ssh:<user>@<host>:<port>`，**不再**用 `session.dir` 分桶。

容器是 [`src/ui/Sidebar.tsx`](../src/ui/Sidebar.tsx)。从上到下：

```
┌ Sidebar ─────────────────────────────────────┐
│ 新建终端  [选目录]  [▾ 含「新建 SSH 连接」]   │
│ 已保存主机（有会话时收成一行）                 │
│ 搜索会话（含 remote.user / host / user@host） │
│ 统一会话动态（需处理 / 正在运行 / 可恢复）     │
│ ── 本地按目录、SSH 按主机 ─────────────────── │
│   组头：目录名或 user@host · 计数 · 折叠/新建/关闭 │
│   卡片：标题 · ⇄ · cwd basename · 连接阶段 · 分支 │
└──────────────────────────────────────────────┘
```

| 区域 | 入口 | 今天对 SSH 做了什么 |
|------|------|---------------------|
| 新建 | [`SidebarNewTerminalControl.tsx`](../src/ui/SidebarNewTerminalControl.tsx) | 主按钮仍是本地终端；溢出菜单第三项打开 `SshConnect` |
| 已保存主机 | [`SidebarHosts.tsx`](../src/ui/SidebarHosts.tsx) | 有会话时默认折叠；该主机已有活会话则聚焦该组，否则打开连接对话框 |
| 搜索 | `Sidebar.tsx` 内 `filtered` | 匹配标题、`dir`，以及 `remote.user` / `remote.host` / `user@host[:port]` |
| 「需要你」一行 | [`AttentionRow.tsx`](../src/ui/AttentionRow.tsx) · [`session-attention.ts`](../src/modules/session/session-attention.ts) | 只计 agent 等待确认与运行中；SSH 连接状态走会话卡片，不进这一行 |
| 分组 | [`sidebar-groups.ts`](../src/modules/session/sidebar-groups.ts) | 本地 `local:<dir>`，SSH `ssh:<user>@<host>:<port>`；OSC 7 只改卡片副标题 |
| 组头 | [`SidebarDirGroupHeader.tsx`](../src/ui/SidebarDirGroupHeader.tsx) | SSH 组显示主机身份 +「SSH」；「+」走 `duplicateOnHost` |
| 组菜单 | [`sidebar-dir-group-menu.ts`](../src/ui/sidebar-dir-group-menu.ts) | SSH 组无本地新建/编辑器；关闭全组走 `closeSessionsInGroup` |
| 卡片 | [`SessionCard.tsx`](../src/ui/SessionCard.tsx) | 远程显示 ⇄；副标题是远端 cwd basename；非 `ready` 的 `connection.phase` 有静默指示 |
| 卡片菜单 | [`sidebar-session-menu.ts`](../src/ui/sidebar-session-menu.ts) | 远程多「在此主机再开一个窗口」，复制远程标识，去掉本地编辑器 |

相关 store 动作：[`closeSessionsInGroup`](../src/state/sessions.ts)、[`reorderInGroup`](../src/state/sessions.ts)、[`duplicateOnHost`](../src/state/sessions.ts)、[`collapsedDirs`](../src/state/ui.ts)（值已是组键）。新建远程会话走 [`createRemoteSession`](../src/state/sessions.ts)，初始 `dir` 为 `user@host`，OSC 7 之后变成远端绝对路径，但组键不变。

---

## 3. 落地前的根因：分组键曾是 `dir`

`session.dir` 同时承担三件事：分组键、卡片副标题、本地「在此目录新建」的路径。这对本地 PTY 成立，对 SSH 不成立。

### 3.1 `dir` 在远程会话上会变

1. 刚连上：[`createRemoteSession`](../src/state/sessions.ts) 把 `dir` 设成 `user@host`。注释写明这不是本地路径，且不进入 `recentDirs`。
2. 远程 shell 发出 OSC 7 后：[`cwdChangedUpdate`](../src/modules/terminal/lib/session-lifecycle.ts) 把 `dir` **整段换成** 远端绝对路径（如 `/root`、`/tmp`）。[`parseOsc7`](../src/modules/terminal/lib/osc-handlers.ts) 对 SSH 信任 PTY 内的 `file://` 主机名，只取出路径。

于是同一条 SSH 会话在侧栏里会换组：先在 `alice@prod` 下，`cd /var/www` 后跑到 `/var/www` 组。折叠状态、组内排序、关闭全组都绑在旧键上，cwd 一变就丢。

[`SessionCard`](../src/ui/SessionCard.tsx) 注释仍写「远程的 `session.dir` 已经是 `user@host`」——这只在 OSC 7 之前为真。

### 3.2 字面路径会把本地和远程混在一起

OSC 7 之后，本地 `/tmp` 和远端 `/tmp` 的 `dir` 相同，`groupByDir` 会把它们放进同一组。

更严重的是组头动作：[`dirGroupHasLocalFilesystem`](../src/ui/sidebar-dir-group-menu.ts) 的判定是「组里是否存在没有 `remote` 的会话」。混合组会被当成本地文件系统，组头出现「在此目录新建终端」，结果是再开一个 **本地** `/tmp` PTY。这不是远程再开一个壳。

两台不同主机若都停在 `/root`，也会被合成一组。

### 3.3 搜索和复制也会偏

搜索只扫 `dir`。OSC 7 之后主机名不在 `dir` 里，搜 `prod` 找不到那条远程会话（除非标题里有）。组菜单「复制路径」在远程组上复制的可能是 `user@host`，也可能是 `/var/www`，调用方无法区分。

### 3.4 已经做对的边界（不要回退）

这些行为应保持，适配时只换分组键，不改传输语义：

- 远程 `dir` 不写入 `recentDirs`，原生选目录器也不接收 `user@host`（[`local-terminal-cwd.ts`](../src/modules/session/local-terminal-cwd.ts)、[`new-terminal-directory-controller.ts`](../src/modules/session/new-terminal-directory-controller.ts)）。
- 组头已经对纯远程组隐藏「在此目录新建本地终端」。
- `duplicateOnHost` 复制 `RemoteInfo`，不复制凭证；密码仍只在单次连接内存中。
- 统一动态从 `connection.phase` 派生，不另存一套「SSH 状态」。
- Inspector 仍按会话裁剪 SSH 页签；侧栏不重复那些页。

---

## 4. 目标信息模型

分组是 **视图派生**，不改 `Session` 持久化形状。`remote`、`dir`（作 cwd）、`workspace` 继续各司其职。

分组已从旧的 `groupByDir` 抽到 [`sidebar-groups.ts`](../src/modules/session/sidebar-groups.ts)（过滤 / 分组 / 排序与渲染拆开）。

### 4.1 组键

```
local:<dir>                  → 现有本地目录组
ssh:<user>@<host>:<port>     → 同一目标主机上的全部远程会话
```

- 端口始终进入键（22 也不省略），避免 `host:22` 与 `host:2222` 合并。
- **按目标主机聚，不按 ProxyJump 路由聚。** 直连和经跳板到同一 `user@host:port` 仍是同一台机器；跳板信息留在连接详情。`route.profileId` 不进入组键。
- 两个 profile 指向同一 `user@host:port` 时合并为一组。组头优先用会话里能读到的 label；否则 `user@host`，非 22 端口再加 `:<port>`。
- `__proto__` / `constructor` 等键继续走现有 `Map` + `Object.fromEntries` 路径，测试已覆盖。

`cd` 与 OSC 7 只更新 `session.dir`，组键不变。

### 4.2 组头展示

| 组类型 | 主标题 | 第二行 | 徽章 |
|--------|--------|--------|------|
| 本地，无 workspace | 目录 basename | — | 会话数 · Agent 数 |
| 本地，有 workspace | 仓库名 | worktree · 分支 · ahead/behind · dirty | 同上 |
| SSH | `user@host`（或 profile label） | 若组内有可展示的 workspace：worktree · 分支；否则省略 | 「SSH」+ 计数 |

SSH 组头不要用文件夹图标冒充本地目录。用现有 ⇄ 或独立主机图标。组 `aria-label` 必须含主机身份，不能只播报 basename。

组内卡片副标题：远端 cwd 的 basename（无 OSC 7 时回退 `user@host` 或「未报告目录」），外加分支 / diff。主机名升到组头后，卡片上不必再重复整段 `user@host`；⇄ 可保留为传输标记，tooltip 仍给完整 `user@host:port`。

### 4.3 组内顺序

保持插入顺序，组内拖拽仍只允许同组重排。置顶继续是卡片上的 ★，**不**把置顶会话抽到列表最外层——命令面板已经按 pinned 分段，侧栏保持「先主机/目录、再会话」。

搜索命中时仍展开全部组（现有 `collapsed && !q`）。搜索字段增加 `remote.user`、`remote.host`、`user@host`、非 22 的端口。

---

## 5. 各区域怎么改

### 5.1 新建终端

**建议：保持现在的三分按钮，只改文案权重。**

- 主按钮：本地终端（当前 cwd / 默认 `~`）。
- 中间：选择本地目录新建。
- 溢出：本地终端、选择目录、分隔、新建 SSH 连接。

不要把主按钮改成「新建会话」再强迫选本地/SSH。终端优先：最常见动作仍是本地壳。SSH 入口已经够：溢出菜单、命令面板、`SidebarHosts`、会话菜单「再开一个窗口」。

活跃会话是 SSH 时，主按钮**仍新建本地终端**（`newTerminal` 已用 [`localTerminalCwdFromSession`](../src/modules/session/local-terminal-cwd.ts) 拒绝远程 cwd）。在此主机再开窗口走组头 / 卡片菜单 / 命令面板，避免「新建」在本地与远程之间来回跳。

### 5.2 已保存主机

**建议：降为附属启动器，不当第二套会话列表。**

现状问题：固定最多 8 行，有会话时也占垂直空间；只在 `overlay` 变化时刷新，设置里改 profile 不一定反映到侧栏；点击一律打开对话框，即使该主机已有活会话。

推荐（按侵入性）：

1. **默认折叠。** 有会话时收成一行「已保存主机 · N」；无会话且有 profile 时展开，方便空工作区起步。
2. **不要**在会话列表里插入空的「离线主机组」。那是主机管理器，不是会话定位器。
3. 点击已有活会话的主机：聚焦该组最近使用的会话，而不是立刻再弹连接框。要再连一次用组头「再开一个窗口」或修饰键（实现时再定，默认先聚焦）。
4. 完整 profile 列表仍在 SSH 连接对话框（已有保存 / config 源）。侧栏最多做最近/收藏入口。

Known hosts 编辑继续留在设置 → SSH，不进侧栏。

### 5.3 统一会话动态

**建议：基本不改。**

[`deriveSessionAttention`](../src/modules/session/session-attention.ts) 已覆盖 `ssh-failed` / `ssh-disconnected`，行内重连预填 `reconnectPrefillFromSession`。这是 SSH 故障的主入口，卡片不必再放第二个重连按钮。

补一小点：连接中（`connecting` / `authenticating` / `needsUserAction` 等）目前既不进动态条，卡片 `StatusDot` 又只看 `runState`。用户在握手阶段会看到一张「空闲」卡。卡片应对非 `ready` 的 SSH `connection.phase` 给静默指示（点或文案），不要新建持久字段。

### 5.4 组头与组菜单

| 动作 | 本地组 | SSH 组 |
|------|--------|--------|
| 折叠 | 按组键写入 `collapsedDirs`（字段名可暂时保留） | 同左 |
| 新建 | `newTerminalInDir(dir)` | `duplicateOnHost(representativeSessionId)` |
| 打开编辑器 | 本地路径 | **无** |
| 复制 | 本地绝对路径 | 两条：复制 `user@host:port`；若 `dir` 已是远端绝对路径再复制 cwd |
| 关闭全部 | `closeSessionsInDir` → 改为按组键 | 关闭该主机上全部会话 |

代表会话：组内活跃会话，否则最近 `updatedAt`。`duplicateOnHost` 已拒绝不可复制的远程字段（[`duplicateRemoteSessionFields`](../src/modules/ssh/connection-share.ts)）。

`closeSessionsInDir(dir)` / `reorderInGroup(dir, …)` 的字符串参数改为组键，或新增 `closeSessionsInGroup` / `reorderInGroupKey` 并让 UI 只走新 API。不要继续用可能碰撞的 `session.dir`。

### 5.5 会话卡片

- 副标题：远端 cwd basename，不是整段 `user@host`（主机已在组头）。
- ⇄ 保留，tooltip 为完整端点。
- `accessibleLabel` 继续区分本地/远程，并加上主机名（现在远程只说「远程 SSH 会话」）。
- SSH 且 `connection.phase` 非 `ready`：状态点或短标签反映连接阶段；`runState` 仍表示壳/Agent，不要把 `disconnected` 画成命令 `failed`。
- 菜单：保留 duplicate / 复制远程标识 / 去掉本地编辑器。可加「复制远端 cwd」（仅当 `dir` 以 `/` 开头，与 [`knownRemoteExplorerRoot`](../src/ui/lib/file-explorer-root.ts) 一致）。

### 5.6 持久化

工作区快照继续只存会话上的 `remote` 与 `dir`，**不**存组键。组键每次从 `remote` 派生。

`ui.collapsedDirs` 的值会变成 `local:…` / `ssh:…`。旧快照里按裸 `dir` 或 `user@host` 存的键对不上，折叠状态丢失一次，可接受。sanitize 已按普通 record key 过滤，不必加新 schema 版本，除非同时改字段名。

不要为侧栏分组新增 snapshot `version`。

---

## 6. 明确不做

- 不在侧栏做主机 CRUD、known_hosts、转发、传输、诊断。
- 不按远端 cwd 做第二层子组。同一主机上的 `/var/www` 和 `/home/app` 就是该组里的两张卡片；仓库信息能从 `workspace` 放到组头第二行就够。
- 不把置顶会话提到全表最前，打乱主机/目录分组。
- 不从侧栏自动执行重连或自动提交恢复命令。动态条已经是「打开重连对话框 / 填入命令」。
- 不把 SSH 主按钮变成默认新建。
- 不在混合语义下调用 `newTerminalInDir(remotePath)`。
- 不把 Inspector SSH 页签搬到左侧。

---

## 7. 落地顺序

阶段 A–D 已于 2026-08-16 合入（见 [PR #81](https://github.com/24kHandsome1201/tunara/pull/81)）。下文保留当时的拆分，方便对照测试。后续体验项（已保存主机点击修饰键再连一次、组头图标是否换成独立主机 glyph）可另开 PR，不要回退组键。

### 阶段 A — 分组键（正确性，应先做）

1. 新增 `sidebarGroupKey(session)` / `groupSessionsForSidebar(sessions)`，单测覆盖：
   - 本地 `/tmp` 与 SSH `/tmp` 分两组
   - 两台主机同为 `/root` 分两组
   - 同一 `user@host:port` 在 OSC 7 前后仍同一组
   - `host:22` 与 `host:2222` 分两组
   - `__proto__` 本地目录仍是普通键
2. `Sidebar`、组头、拖拽、`closeSessionsInDir`、`reorderInGroup`、`collapsedDirs` 改用组键。
3. 卡片副标题与组头文案按 §4.2 / §5.5 改；修正「`dir` 已是 user@host」的过时注释。
4. 搜索匹配 `remote.user` / `remote.host`。
5. 结构回归：现有 `project-review-regressions` 里对 `dirGroupHasLocalFilesystem` 的断言改为「组键已隔离传输，本地组才出现新建终端」。

### 阶段 B — SSH 组动作

1. SSH 组头「+」→ `duplicateOnHost`，不再隐藏新建。
2. 组菜单复制远程标识 / 远端 cwd；无「打开本地编辑器」。
3. SSH 组头图标与 `aria-label`。

### 阶段 C — 已保存主机

1. 有会话时默认折叠成一行。
2. 该主机已有会话则聚焦，而不是必弹对话框。
3. profile 变更后刷新（不要只听 `overlay`）。

### 阶段 D — 连接阶段可见性

1. 卡片对非 `ready` 的 SSH phase 给静默指示。
2. 不把 connecting 塞进「需要处理」动态条，避免握手变成故障。

每阶段可独立 PR。A 不依赖视觉稿；C 若有争议可只做折叠、不做「点击聚焦」。

---

## 8. 测试与回归

自动化（阶段 A 必须有）：

- `sidebarGroupKey` / `groupSessionsForSidebar` 表驱动测试，含 OSC 7 换 cwd、混合 `/tmp`、双主机同路径。
- 组菜单：纯 SSH 组无本地新建/编辑器；纯本地组不变。
- `duplicateOnHost` 仍只复制 secret-free `RemoteInfo`。
- 快照：含 `remote` 的会话恢复后组键仍从 `remote` 派生，不读已废弃的折叠键。

手工（阶段 B/C/D）：

- 连一台一次性 SSH 主机，开两个壳，分别 `cd` 到不同目录：侧栏仍一组，两张卡片副标题不同。
- 同时开本地 `/tmp` 与远端 `/tmp`：两组，本地组「+」开本地壳，SSH 组「+」再开远程壳。
- 断开连接：动态条出现重连；折叠该主机组后动态条仍在。
- 窄窗口侧栏改抽屉：组头与主机折叠仍可用，见 [VISUAL_QA.md](./archive/VISUAL_QA.md)。
- 屏幕阅读器：组名含主机身份，卡片含远程/本地，见 [ACCESSIBILITY_MANUAL_QA.md](./archive/ACCESSIBILITY_MANUAL_QA.md) 侧栏项。

不把真实 SSH 主机写进单测；用 session fixture 即可。性能门仍是列表 memo、分组与渲染拆开，见 ROADMAP。

---

## 9. 和右侧栏的分工

| 用户问题 | 左侧栏 | 右侧栏 / 其他 |
|----------|--------|----------------|
| 我有哪些壳、在哪台机器？ | 按本地目录 / SSH 主机分组 | — |
| 这台机器再开一个壳 | 组头 / 卡片「再开一个窗口」 | 命令面板已有 |
| 连一台新机器 | 新建菜单、折叠的已保存主机 | `SshConnect`：首屏一个 `user@host[:port]` 输入框，回车即连；认证默认自动（agent → IdentityFile/默认密钥 → 服务器要密码时才弹）。高级认证、跳板、诊断只在失败后或点「高级…」时出现。成功后自动保存主机（不含密码）。 |
| 连接断了怎么办 | 动态条原位重连 | 终端故障提示与诊断报告 |
| 远端文件 / 传输 / 转发 | 不放 | Files、Transfers、Forwarding |
| 改 known_hosts | 不放 | 设置 → SSH |
| 这台机器打开了哪些文件？ | 不放（避免和第二份标签条重复） | 标题栏当前设备工作面，见 [TITLEBAR_DEVICE_TABS.md](./TITLEBAR_DEVICE_TABS.md) |

侧栏适配完成后，[FEATURES.md](./FEATURES.md) 已写成「本地按目录、SSH 按主机」。不要再改回「只按工作目录分组」。标题栏不要再把全部会话和跨设备文件平铺成第二条定位器。
