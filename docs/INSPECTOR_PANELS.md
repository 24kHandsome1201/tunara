# 右侧栏（Inspector）页面盘点

本文是一份**现状分析与优化提案**，不是已落地的产品合同。撰写日期：2026-08-15。

它对照当前代码，盘点右侧栏 10 个页面的职责、入口、依赖 API、已知问题与取舍建议。产品原则仍以 [GOAL.md](./GOAL.md) 为准；用户可见能力对照以 [FEATURES.md](./FEATURES.md) 为准。文中「进行中」表示仓库内已有并行改动，提案不应与之打架。

---

## 1. 概述

右侧栏（Inspector）是主窗口三栏布局中的**当前会话检查器**：终端负责执行，侧栏负责定位，Inspector 负责只读上下文与轻量操作。它不建设 IDE，也不替代 Git / 浏览器 / 编辑器。

容器是 [`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx)。页签由 Zustand `useUIStore.inspectorTab` 切换，**没有路由**。一次只挂载当前页；窄窗口时整栏改为覆盖层，见 [`src/app/lib/app-shell-layout.ts`](../src/app/lib/app-shell-layout.ts)。纯净模式可只打开 Files（`filesOnly`），不展开整栏检查器。

### 1.1 导航模型

清单定义在 [`src/ui/inspector-navigation.ts`](../src/ui/inspector-navigation.ts)，作用域标签在 [`src/ui/inspector-scope.ts`](../src/ui/inspector-scope.ts)。

| 层级 | 页签 | 溢出分组 |
|------|------|----------|
| 常驻主 tab | 概览、改动、文件 | — |
| 「更多」菜单 | Preview、笔记 | `workspace` |
| 「更多」菜单 | 传输 | `transfer` |
| 「更多」菜单 | 端口转发 | `ssh` |

主 tab 始终可见。从「更多」打开的次级页会临时出现在 tab 条上，与三个主 tab 并列，直到切回主 tab。

溢出菜单按分组插入标题：工作区、传输、SSH。选中项前加勾号。

### 1.2 可见性

`resolveInspectorNavigation({ filesOnly, isRemote })` 按会话裁剪：

- **本地会话**：概览、改动、文件、Preview、笔记（5 个）。
- **SSH 远程会话**：再加上传输、端口转发。
- `filesOnly`：只保留文件。

远程专用 2 项（传输、端口转发）对本地会话不可见。元数据改为 Files 右键属性弹窗；诊断并入概览；已知主机在设置 → SSH。

### 1.3 作用域标签

部分页面会显示 scope 徽章（全局 / profile / 逻辑会话 / 传输绑定）。已知主机是全局配置，却挂在会话检查器里；scope 标签某种程度上是在为这类错位打补丁。见第 10 节。

---

## 2. 概览（Overview）

**建议：保留。** 定位为会话驾驶舱：摘要 + 导航，而不是第二份 Diff / Notes。

### 作用

会话标题与吉祥物、四张信息卡（状态、Agent、目录或远程地址、Git 改动数）、workspace / worktree 卡片、最近命令、时间线（最多 12 条）、快捷按钮（置顶、打开笔记、复制路径、新终端、外部编辑器、刷新 Git、重连）。远程连接异常时渲染 [`SessionRemediationNotice`](../src/ui/SessionRemediationNotice.tsx)。

### 实现位置

[`src/ui/SessionOverviewPanel.tsx`](../src/ui/SessionOverviewPanel.tsx)（279 行）。依赖 [`session-insights.ts`](../src/modules/session/session-insights.ts)、[`session-notes.ts`](../src/modules/session/session-notes.ts)、[`session-mascot.ts`](../src/modules/session/session-mascot.ts)、[`src/state/timeline.ts`](../src/state/timeline.ts)。

### 依赖 API

无独立 IPC。读 `useSessionsStore`（会话、时间线、置顶、`refreshGit`、`newTerminalInDir`）和 `useUIStore`（切到笔记 tab、打开 SSH 重连预填）。本地「打开外部编辑器」走 `openInEditorWithToast`。

### 现状问题

- 改动数与笔记 todo 统计分别与 Diff / Notes tab 重复计算。
- 信息卡不可点击，驾驶舱无法把用户送到对应详情页。
- 内联 `InfoCard` / `ActionButton` 与共享的 `PanelToolbar` / `PanelActionButton` 不一致。

### 优化建议

- 卡片可点击跳转：改动数 → Changes，目录 → Files，笔记按钮已切 tab，可把「摘要 + 导航」写进交互。
- 样式迁到共享组件，避免每个面板各写一套按钮。
- 若砍掉诊断独立 tab（第 9 节），连接异常时在此增加「复制诊断报告」按钮。

---

## 3. 改动（Changes）

**建议：保留。** 只读 Git review 是产品卖点，不可砍。

### 作用

按暂存区分组的文件列表，展开 hunk、diff 内搜索高亮、复制、跳外部编辑器。本地与 SSH 共用同一套 UI。

### 实现位置

[`src/ui/DiffPanel.tsx`](../src/ui/DiffPanel.tsx)（793 行）。解析与虚拟滚动在 [`src/ui/lib/diff-parse.ts`](../src/ui/lib/diff-parse.ts)、[`src/ui/lib/diff-virtual.ts`](../src/ui/lib/diff-virtual.ts)。桥接 [`src/modules/git/git-bridge.ts`](../src/modules/git/git-bridge.ts)。

`DiffFileRow` 与 `MiniDiff` 仍定义在同一文件内。

### 依赖 API

| 场景 | 前端 | IPC |
|------|------|-----|
| 本地 diff | `gitDiff` | `git_diff` |
| 本地 ahead/behind | `gitAheadBehind` | `git_ahead_behind` |
| 远程 diff | `sshGitDiff` | `ssh_git_diff` |
| 远程 ahead/behind | `sshGitAheadBehind` | `ssh_git_ahead_behind` |
| 取消进行中的远程 diff | `cancelGitDiff` | `fs_cancel_search` |

文件列表本身来自会话上已刷新的 `session.changes`（本地 `git_status` / 远程 `ssh_git_status`），不由本面板单独拉全量 status。

### 现状问题

- `MiniDiff` 已有简单虚拟滚动，大文件仍缺语法高亮。
- 展开状态是单一 `expandedFileKey`：同时只能打开一个文件，切换会话或文件集合变化时会丢掉。
- 793 行单文件同时容纳分组头、文件行、hunk 渲染与加载状态。

### 优化建议

- 拆出 `DiffFileRow` / `MiniDiff` 为独立文件。
- 按文件记住展开状态（至少在同一次会话浏览内）。
- 按需加语法高亮；不要为此引入完整编辑器。

---

## 4. 文件（Files）

**建议：保留。** 核心功能。搜索 / 树 / 上传已拆到 `src/ui/file-explorer/` 自定义 hook；壳组件仍负责编排下载、右键菜单与 JSX。

### 作用

本地 / 远程文件浏览器：目录树 + 列表、按名搜索、内容 grep、排序、隐藏文件、右键菜单、新建 / 重命名、拖拽上传、批量下载。远程走 SFTP / exec channel。本地会话仍锁在工作区目录；SSH 会话以远端 `/` 为浏览根，主目录和终端 cwd 只是起点与快捷位置。打开的文件可作为主区标签与终端并列。

### 实现位置

壳组件 [`src/ui/FileExplorer.tsx`](../src/ui/FileExplorer.tsx)（约 1600 行），领域逻辑在 [`src/ui/file-explorer/`](../src/ui/file-explorer/)：`use-explorer-search.ts`、`use-tree-listing.ts`、`use-direct-upload.ts`、`upload-preflight.ts`，以及 icons / helpers / transfer-failures。本地桥接 [`src/modules/fs/fs-bridge.ts`](../src/modules/fs/fs-bridge.ts)，远程 [`src/modules/ssh/remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts)，变更 [`src/modules/ssh/remote-fs/`](../src/modules/ssh/remote-fs/)，传输意图 [`src/modules/ssh/transfer-intent.ts`](../src/modules/ssh/transfer-intent.ts) / [`transfer-store.ts`](../src/modules/ssh/transfer-store.ts)。

右键「元数据」通过 `onInspectRemotePath` 把路径塞给 `InspectorPanel` 的 `metadataPath`，再切到元数据 tab。

### 依赖 API

| 能力 | 本地 | 远程 |
|------|------|------|
| 列目录 | `fs_read_dir` | `ssh_fs_read_dir` |
| 按名搜索 | `fs_search` | `ssh_fs_search` |
| 内容 grep | `fs_grep` | `ssh_fs_grep` |
| 家目录 | — | `ssh_fs_home` |
| 上传 / 下载 | — | `sshUpload` / `sshDownload` 及 transfer store |
| 新建 / 重命名 / 删除 | — | `ssh_fs_mutate_v1`（`performRemoteMutation`） |
| 远程 stat | — | `sshStatV1`（变更前置条件） |

### 现状问题

- 壳组件仍偏大：下载、右键菜单、变更对话框、JSX 编排还在 `FileExplorer.tsx`。
- 搜索 / 树 / 上传已各自带 generation / 取消令牌；下载与变更仍散落在壳里。
- 传输从本面板发起，进度却藏在「更多 → 传输」，进行中缺少就地入口。

### 优化建议

- 下载与变更也可再抽 hook，但不要再开一轮平行大重构。
- 与第 7 节配合：列表区增加「N 个传输进行中」迷你入口，跳到传输中心。
- 跨页改动（属性弹窗、传输入口）可以按现有 `file-explorer/` 边界小 PR 接入。

---

## 5. Preview

**建议：保留。** 与「agent 写前端 → 看效果 → 截图 / 报错喂回」工作流绑定。

### 作用

workspace-bound 的 dev server 预览控制：打开 / 刷新 / 前进后退 / 地址栏、缩放与视口预设（手机 390×844、平板 768×1024、桌面 1280×720）、截图回传源终端、页面报错遥测、远程自动开 SSH 隧道。不自动扫端口，不自动启动服务。合同见 [PHASE3_PREVIEW_SOURCE_CONTRACT.md](./PHASE3_PREVIEW_SOURCE_CONTRACT.md)。

### 实现位置

[`src/ui/PreviewPanel.tsx`](../src/ui/PreviewPanel.tsx)（359 行）。`SourceCard` 承担单来源的全部控件。桥接 [`src/modules/preview/preview-window.ts`](../src/modules/preview/preview-window.ts)，后端 [`src-tauri/src/modules/preview.rs`](../src-tauri/src/modules/preview.rs)。

### 依赖 API

`previewOpen` / `previewClose` / `previewStatus` / `previewNavigate` / `previewGoBack` / `previewGoForward` / `previewRefresh` / `previewSetZoom` / `previewSetViewport` / `previewCapture` / `previewSendCaptureToSourceTerminal` / `previewTelemetrySend`；远程叠加 `previewTunnelOpen` / `previewTunnelClose` / `previewTunnelStatus`。

### 现状问题

- `SourceCard` 每 750ms 轮询 `previewStatus`，远程再叠一次 `previewTunnelStatus`。页面隐藏时已暂停，回到前台会立即补同步。
- 「身份详情」折叠区展示 repository / worktree / workspace / session / terminal / generation / physical PTY 等内部 ID；远程再加 SSH host、远端 URL、端口与隧道端点。对日常预览无帮助。
- 一个 `SourceCard` 兼隧道、导航、截图、遥测四职责。

### 优化建议

- 状态改为后端事件推送；若短期不能推送，稳定后把轮询退避到 3–5 秒。
- 身份详情砍掉，或藏到调试开关后面。
- 按职责拆 `SourceCard`（隧道、导航条、视口 / 截图、遥测）。

---

## 6. 笔记（Notes）

**建议：保留。** 可选并入概览，但收益不大。

### 作用

当前会话便签：350ms 防抖自动保存，失焦与切会话时冲刷未保存编辑，todo 统计，清空（二次确认）与复制。

### 实现位置

[`src/ui/SessionNotesPanel.tsx`](../src/ui/SessionNotesPanel.tsx)（139 行）。纯函数在 [`src/modules/session/session-notes.ts`](../src/modules/session/session-notes.ts)。写入 `useSessionsStore.setSessionNote`。

### 依赖 API

无独立 IPC。笔记随工作区快照持久化，见 [STATE_AND_PERSISTENCE.md](./STATE_AND_PERSISTENCE.md)。

### 现状问题

单独占一个「更多」菜单项。概览已有「打开笔记」按钮和 todo 计数，信息略有重叠。

### 优化建议

可把笔记做成概览里的可展开区块，省一个菜单项。但本面板代码小，防抖与切会话边界已经很细，合并容易把驾驶舱再撑大。默认保持独立 tab。

---

## 7. 传输（Transfers）

**建议：保留。** 在 Files 加迷你进度入口。

### 作用

SSH 上传 / 下载进度中心：单文件与批量进度、取消 / 重试、失败恢复（reconcile / 重来 / 删除残留 / 忽略）、本会话与全局视图、`aria-live` 进度播报。

### 实现位置

[`src/ui/TransferCenter.tsx`](../src/ui/TransferCenter.tsx)（198 行）。状态 [`src/modules/ssh/transfer-store.ts`](../src/modules/ssh/transfer-store.ts)，后端 [`src-tauri/src/modules/ssh/transfer/`](../src-tauri/src/modules/ssh/transfer/)。

仅远程会话出现，溢出分组为 `transfer`（与 SSH 组分开）。

### 依赖 API

`useTransferStore`：`cancel` / `cancelBatch` / `cancelAll` / `retry` / `clearFinished` / `reconcileRecovery` / `restartRecovery` / `deleteRecoveryPartial` / `dismissRecovery`。完成上传后可用 `openResource` 在主区预览目标文件。

### 现状问题

传输从 Files 发起，进度藏在「更多」。用户上传后必须再开一次溢出菜单才能看到进度或恢复项。

### 优化建议

在 FileExplorer 工具条或列表底部加「N 个传输进行中 →」，点击切到本页。不要在 Files 里重做一整套进度 UI。

---

## 8. 元数据（Metadata）

**建议：砍掉独立 tab。** 改为 FileExplorer 内的「属性」弹窗或抽屉。

### 作用

针对**单个远程路径**的 stat：类型、rwx / 八进制、属主、symlink 目标，以及有条件的 chmod。

### 实现位置

[`src/modules/ssh/remote-fs/RemoteMetadataPanel.tsx`](../src/modules/ssh/remote-fs/RemoteMetadataPanel.tsx)（150 行）。路径来自 `InspectorPanel` 的 `metadataPath` state（默认 `session.dir`）。FileExplorer 右键「元数据」会写入该路径并切 tab。

无 binding 时导航本应隐藏此 tab；若状态仍落在 `metadata`，容器会**兜底渲染 Overview**，tab 条与内容错位。

### 依赖 API

`sshStatV1`（远程 stat）、`performRemoteChmod`（带父子前置条件的 chmod）。

### 现状问题

- 本质是「针对某文件的操作」，不是独立页面。
- 从「更多」直接进入只能看会话根目录，容易误以为这是会话级面板。
- 为它单独维护 `metadataPath` 和 `hasBinding` 特判，成本高于收益。

### 优化建议

- 在 FileExplorer 右键打开属性弹窗 / 抽屉，复用现有 `RemoteMetadataPanel` 主体。
- 删除 `InspectorPanel` 的 `metadataPath`、`onInspectRemotePath` 跳转，以及 `resolveInspectorNavigation` 里对 `metadata` 的 `hasBinding` 特判。

---

## 9. 端口转发（Forwarding）

**建议：保留。** SSH 正经功能；统一 UI 风格并补齐小交互。

### 作用

创建与管理三类转发：本地转发、动态 SOCKS5、远程转发。支持「重连后自动重建」。列表可停止单条规则。`InspectorPanel` 用 `session.id + ptyId + transportGeneration` 作 `key`，断线时 `binding` 置空。

### 实现位置

[`src/modules/ssh/ForwardingPanel.tsx`](../src/modules/ssh/ForwardingPanel.tsx)（241 行）。桥接 [`src/modules/ssh/forwarding-bridge.ts`](../src/modules/ssh/forwarding-bridge.ts)。

### 依赖 API

`listLocalForwards` / `listDynamicForwards` / `listRemoteForwards`，以及对应的 `start*` / `stop*`。请求用 epoch + binding key 丢弃过期响应，竞态防护扎实。

### 现状问题

- UI 是裸 `h2` / `ul` / `li`，与 `PanelToolbar` / `PanelActionButton` 不统一。
- 端口填 `0` 时由系统分配临时端口，列表只标「临时」，没有一键复制 `localhost:端口`。
- 表单校验失败一律 `invalidIntent`，无法标到具体字段（本地端口 / 目标主机 / 目标端口）。

### 优化建议

- 改用共享工具条与列表卡片。
- 临时端口分配成功后提供复制 `bindHost:port`。
- 校验错误落到对应输入，而不是一条笼统 alert。

---

## 10. 诊断（Diagnostics）

**建议：砍掉独立 tab。** 复制报告并入概览；`diagnostics-store` 数据源保留。

### 作用

当前会话的 SSH 诊断事件流水（`stage` / `status` / `code`），可复制报告、清空。面板内再次渲染 `SessionRemediationNotice`。

### 实现位置

[`src/modules/ssh/DiagnosticsCenter.tsx`](../src/modules/ssh/DiagnosticsCenter.tsx)（56 行）。数据 [`src/modules/ssh/diagnostics-store.ts`](../src/modules/ssh/diagnostics-store.ts)，报告文本 [`diagnostics-bridge.ts`](../src/modules/ssh/diagnostics-bridge.ts)。

切到此 tab 时 `InspectorPanel.selectTab` 会调用 `diagnosticsCenter.open()`。面板 `onClose`（工具条关闭或 Escape）跳回 Overview。

### 依赖 API

`diagnosticsForSession` / `clearSessionDiagnostics` / `diagnosticReportText`。底层仍是 `ssh_diagnostic_*_v1`，本面板只展示已记录事件。

### 现状问题

- `stage` / `code` 对普通用户不可读。
- 可操作的修复提示已由 `SessionRemediationNotice` 承担，Overview 也会渲染，此处重复。
- `onClose` 跳回 Overview、切 tab 必须 `diagnosticsCenter.open()`，是历史遗留耦合。

### 优化建议

- 去掉独立 tab 与 `open()` / `onClose` 耦合。
- 在 Overview 连接异常时放「复制诊断报告」。
- 保留 `diagnostics-store`，供通知、日志和复制报告使用。

---

## 11. 已知主机（Known Hosts）

**建议：移出右侧栏。** 放到全局设置的 SSH 分区。

### 作用

全局 `known_hosts` 列表：指纹、刷新、二次确认后删除。不绑定当前会话。

### 实现位置

[`src/modules/ssh/KnownHostsPanel.tsx`](../src/modules/ssh/KnownHostsPanel.tsx)（73 行）。桥接 [`src/modules/ssh/known-hosts-bridge.ts`](../src/modules/ssh/known-hosts-bridge.ts)（`listKnownHostsV1` / `refreshKnownHostsV1` / `removeKnownHostV1`）。

`inspector-scope` 将其标为 `global`。连接过程中的 TOFU 决策仍在 [`HostKeyPrompt`](../src/ui/overlays/HostKeyPrompt.tsx)，与本列表是两条路径。

### 依赖 API

上述 `*_v1` 已知主机命令。删除带 `revision` + `entryId`，不可管理的条目按钮禁用。

### 现状问题

- 全局配置挂在「当前会话检查器」的溢出菜单里，和 Inspector 的会话作用域不符。
- 删除主机密钥是安全敏感操作，不宜藏在会话「更多」里。
- scope 徽章系统在为此类错位打补丁。

### 优化建议

整页迁到设置 → SSH。右侧栏不再出现该 tab。连接期的 Host Key 提示对话框保持不动。

---

## 12. 取舍结论

| 页面 | 建议 | 备注 |
|------|------|------|
| 概览 | 保留 | 目录 / 改动卡片可跳转；连接异常时可复制诊断报告 |
| 改动 | 保留 | 核心 review；拆分子组件、记展开状态仍待做 |
| 文件 | 保留 | 搜索 / 树 / 上传已拆模块；右键属性弹窗；工具条有传输入口 |
| Preview | 保留 | 身份 ID 已去掉；轮询退避到 4s；完整事件推送仍待做 |
| 笔记 | 保留 | 可选并入概览，默认不合并 |
| 传输 | 保留 | Files 工具条「N 个传输进行中」入口已落地 |
| 端口转发 | 保留 | PanelToolbar、临时端口复制、字段级校验已落地 |
| 元数据 | 已砍 tab | FileExplorer 右键「属性」弹窗 |
| 诊断 | 已砍 tab | 概览在连接异常时复制报告；store 保留 |
| 已知主机 | 已移出右侧栏 | 设置 → SSH |

收敛后 **10 个页面变为 7 个**（本地会话仍是 5 个：概览、改动、文件、Preview、笔记）。远程「更多」里的专用项从 5 个变为 2 个（传输、端口转发）；导航中的 `ssh` 分组从 4 项缩到 1 项（端口转发）。

已删除：

- `InspectorPanel` 的 `metadataPath` 与 `onInspectRemotePath`
- `resolveInspectorNavigation` 的 `hasBinding` / `metadata` 特判
- Diagnostics 的 `diagnosticsCenter.open()` 与独立 tab / `onClose` 跳回 Overview

---

## 13. 跨页面通用优化

1. **按需加载 SSH 面板。** 传输与端口转发已改为 `React.lazy`；本地会话不再静态打包这两个模块。
2. **统一工具条。** Overview、Preview 仍有部分内联样式；Forwarding 已用 `PanelToolbar` / `PanelActionButton`。新改动应靠齐共享组件。
3. **主 tab 承担导航。** Overview 卡片跳转、Files 传输入口，减少「更多」里才能完成的闭环。
4. **不要用 scope 徽章掩盖错位。** 全局或「单文件操作」不应继续塞进会话检查器；迁走后徽章只描述真正的会话 / 绑定范围。
5. **一次只挂载当前页。** 现有模型保持。懒加载后仍应卸载不可见面板，避免 SSH 轮询在后台跑。
6. **FileExplorer 拆分边界已稳定。** 跨页改动（属性弹窗、传输入口）按 `src/ui/file-explorer/` 小 PR 接入即可。
