# 通知审计

基线：`origin/main` @ `833c489`。只读源码，未改 `src/` / `src-tauri/`。

原则：软件跟用户说话只留两个出口。

- **Toast**：一次性，几秒消失。用于「刚才那下有没有做成」，别处看不到。
- **侧栏「需要你」一行**：持续性，带数字。用于还没做完的事。

其余每一处：并进这两个，或删。

三条终端上方提示条（`SshSuggestionBar` / `PreviewSuggestionBar` / `ReviewChangesBar`）和侧栏 `GlobalAgentBar`：**已在处理**。本表标出来，不给第二套方案。

Rust 侧 `src-tauri/src` 没有 notification / dock / badge / `requestUserAttention` 调用。Dock 弹跳和角标都走前端 Tauri window API。`notify` crate 只用于 Git 文件监视，不发声。没有系统通知插件。

---

## 统计

| 项 | 数量 |
| --- | --- |
| 出口类型 | 13 |
| 调用点（下表行数） | 112 |
| 建议：删除 | 32 |
| 建议：保留（Toast） | 28 |
| 建议：并入「需要你」 | 16 |
| 建议：改为内联静默状态 | 22 |
| 建议：保留模态（要答案，不是发声） | 6 |
| 建议：已在处理 | 4 |
| 建议：需要设计后再动 | 4 |

出口类型：Toast、退出/错误横幅、连接遮罩、SSH 恢复条、Dock 弹跳、Dock 角标、OSC 系统通知（已空实现）、终端上方提示条、侧栏 GlobalAgentBar、Inspector 建议条、传输面板告警/朗读、模态、终端内联写入。面板里的 `role="status"` / `role="alert"`（表单错误、加载中、脏标记）不算独立出口，归「内联状态」。

`addToast` 生产调用点 73 处（不含 store 定义，不含测试）。下表把同一函数里按状态分叉的文案拆开写。

---

## 特别关注

### (a) 成功类 toast 哪些多余

多余（操作成功后弹「已完成」，别处已经有结果）：

| 调用 | 为什么多余 |
| --- | --- |
| `sessions.ts:659` Agent 已完成 | 未读点、会话卡、`GlobalAgentBar` 已有 |
| `sessions.ts:746` 后台命令成功 | 同上；失败才值得说话 |
| `SshConnect.tsx:246` SSH 配置已刷新 | 列表自己变了 |
| `pty-bridge.ts:47` 主机密钥已保存 | 用户刚在模态里点了「信任」 |
| `remote-external-edit.ts:157` 外部编辑器已打开 | 编辑器窗口就是反馈 |
| `FileExplorer.tsx:186/917` 下载已加入队列 | 传输面板就是队列 |
| `TerminalViewChrome.tsx:178` 拖放已入队 | 同上 |
| `transfer-store.ts:198` / `use-direct-upload.ts:173` 上传完成 | 传输面板有完成态和预览入口 |
| `terminal-export-file.ts:36` 已导出 | 系统保存对话框已经选定路径 |

要留的成功 toast（别处没有反馈）：

- 剪贴板：`clipboard.copy_success`、`connection.diagnostics.copied`、`diff.toast.hunk_copied`。剪贴板本身不响。
- 单文件下载完成：`explorer.download.complete`。保存对话框只选路径，写盘结果只有 toast。
- 转发临时端口变了：`ssh.forward.ephemeralRecreated`。端口号变了，别处不说。
- 导出被截断：`term.export.truncated` 这条副文案。完整导出可删成功 toast，截断要留。

### (b) 更新提醒是否克制

**是，实现与 README 一致。**

README：`Delayed signed-update reminders that stay silent until a release is actually available`。

实现（`useUpdateReminder.ts`）：

- 工作区 `ready` 之后再等 **18s**（`UPDATE_REMINDER_DELAY_MS`）。
- `import.meta.env.DEV` 直接 return，开发态不检查。
- `check({ timeout: 15_000 })`；`if (!update) return`；失败 `.catch` 空。
- 每次启动最多一条 toast，10s，带「查看更新」。
- 设置里的 `useAppUpdate` 只在用户打开「应用」页时检查，写在该页内部，不另弹。

没有轮询、没有失败提示、没有「已是最新」。时机和频次克制。去向仍是 toast；若「需要你」能挂一条「有更新」，启动 toast 可再删。不急。

### (c) Toast.tsx 三个特性

从用户视角：

| 特性 | 必要？ | 判断 |
| --- | --- | --- |
| 退出动画（250ms `toastOut`） | 否 | 用户不读退场。删掉直接卸 DOM。 |
| 悬停/焦点暂停倒计时 | 是 | 默认 4s / 错误 12s。不停的话来不及读、来不及点。也对 WCAG 2.2.1。 |
| 底部 2px 进度条 | 否 | 没人盯那条线。暂停逻辑不依赖它。 |

建议：留暂停，删退场动画和进度条。

---

## 调用点

列：文件:行号 | 触发 | 文案 | 类型 | 别处能否看到 | 建议 | 理由

### Toast

| 文件:行号 | 触发 | 文案（key · 中文） | 类型 | 别处能否看到 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/state/sessions.ts:524` | 批量关闭仍在跑的会话，第一次点击 | `destructive.confirm_again.close` · 再次点击确认关闭 / `session.close.running_hint` · 进程运行中，再次点击关闭 | toast | 否 | 需要设计 | 这是二次确认，不是通知。toast 当确认很弱。 |
| `src/state/sessions.ts:659` | 后台 Agent 一轮跑完 | Agent 名 / `agent.toast.done` · 已完成（或 `done_files`） | toast | 是：未读、会话卡、gbar | 删除 | 成功且持久状态已在侧栏。 |
| `src/state/sessions.ts:699` | 后台 Agent 进程退出 | 成功同上一行；失败 `agent.toast.exited` · 已退出（退出码 N） | toast | 是：未读 + gbar | 并入「需要你」 | 失败要挂着；成功删 toast。 |
| `src/state/sessions.ts:746` | 后台命令结束（非 Agent） | 命令原文 / `command.toast.done` · 已完成 或 `failed` · 失败（退出码 N） | toast | 是：未读、会话卡 | 并入「需要你」 | 成功删；失败进「需要你」。≥15s 的 Dock 弹跳并进同一条。 |
| `src/state/sessions.ts:921` | 文件名含换行，无法在终端打开 | `explorer.open_terminal.failed` · 无法在终端中打开文件 | toast | 否 | 保留 | 动作失败，列表无变化。 |
| `src/state/sessions.ts:977` | 对本地会话点「同一主机再开窗口」 | `session.duplicate.ssh_only` · 仅 SSH 会话可以在同一主机再开窗口 | toast | 否 | 删除 | 菜单项应对本地会话禁用，而不是点了再骂。 |
| `src/state/sessions.ts:1001` | 关闭单个仍在跑的会话，第一次点击 | 同 524 | toast | 否 | 需要设计 | 与批量关闭同一问题。 |
| `src/state/ui.ts:725` | 用户配置读写失败 | `settings.config_error` · 配置错误 + 底层 message | toast | 否 | 保留 | 设置页可能没开。丢配置必须说。 |
| `src/app/useInit.ts:84` | 工作区恢复失败或保存失败（每种一次） | `workspace.restore_error.title` · 工作区恢复已暂停 / `workspace.save_error.title` · 工作区未保存 | toast | 否 | 保留 | 写盘停了，没有第二处告警。 |
| `src/app/useUpdateReminder.ts:24` | 启动 18s 后检查到已签名更新 | `update.reminder.title` · Tunara vX 已就绪 | toast | 设置→应用 页也有 | 保留 | 克制；设置页用户未必打开。以后可改挂「需要你」。 |
| `src/app/useGlobalShortcut.ts:67` | 全局热键注册失败 | `settings.global_shortcut.conflict` · 热键已被其他应用占用或格式无效 | toast | 设置页有同一开关 | 保留 | 改快捷键当时人在设置里，但启动注册失败时不在。 |
| `src/app/useKeybindings.ts:135` | 快捷键「下一个需要处理的会话」，当前没有 | `attention.none` · 没有需要处理的会话 | toast | 是：侧栏空 | 删除 | 快捷键没跳转就是答案。 |
| `src/ui/overlays/CommandPalette.tsx:204` | 命令面板同一动作，当前没有 | 同上 | toast | 是 | 删除 | 同上。 |
| `src/ui/TerminalView.tsx:454` | 本地 PTY 打开失败 | `pty.error.title` · 终端启动失败 | toast | 是：`PtyErrorBanner` | 删除 | 横幅已经盖在死终端上。 |
| `src/modules/terminal/lib/pty-bridge.ts:176` | SSH `ssh_open` 失败 | `ssh.error.title` · SSH 连接失败 + 安全处理后的 message | toast | 是：横幅 + 连接 phase | 并入「需要你」 | 失败是持续态。横幅留给当前窗格按钮。 |
| `src/modules/terminal/lib/pty-bridge.ts:47` | 主机密钥写入 known_hosts 的结果 | `ssh.hostKey.persistence.saved` · 已保存；`sessionOnly` · 仅本次；`preCommitFailure` / `committedButDurabilityUnknown` / `failed` | toast | 模态刚关 | 删除 saved；保留非 saved | 「已保存」重复用户手势。写盘不确定必须说。 |
| `src/modules/terminal/lib/pty-bridge.ts:643` | 新开 SSH 时作废旧键盘交互提示 | `ssh.keyboardInteractive.stale` · 为确保安全，已取消过期的认证提示 | toast | 模态被撤 | 保留 | 安全：告诉用户没发出去。 |
| `src/modules/terminal/lib/pty-bridge.ts:735` | 丢弃非当前连接的键盘交互事件 | 同上 | toast | 否 | 保留 | 同上。三条可收成一个函数，文案仍要。 |
| `src/modules/terminal/lib/pty-bridge.ts:780` | 键盘交互 origin 与当前连接不匹配 | 同上 | toast | 否 | 保留 | 同上。 |
| `src/ui/overlays/KeyboardInteractivePrompt.tsx:31` | 提交键盘交互回答失败 | `ssh.keyboardInteractive.response_failed` · 此认证请求已失效 | toast | 模态还在或已关 | 保留 | 回答没送出。 |
| `src/ui/overlays/HostKeyPrompt.tsx:29` | 提交主机密钥决定失败 | `ssh.hostKey.decision_failed` · 无法提交主机密钥决定，请重试 | toast | 模态还在 | 保留 | 连接仍停。 |
| `src/ui/SessionRemediationNotice.tsx:17` | 点恢复时 generation 已过期 | `remediation.stale` · 此恢复操作已失效 | toast | 横幅会消失 | 保留 | 点了没做事，必须说。 |
| `src/modules/ssh/auto-reconnect.ts:113` | 重连前抓转发快照失败 | `ssh.forward.snapshotFailed` · 无法保存当前的端口转发设置 | toast | 转发面板之后会对不上 | 保留 | 静默会丢规则。 |
| `src/modules/ssh/auto-reconnect.ts:210` | 重连后重建转发失败 | `ssh.forward.rebuildFailed` · 无法重新创建 SSH 转发 | toast | 转发面板会缺规则 | 保留 | 端口没恢复。 |
| `src/modules/ssh/auto-reconnect.ts:220` | 临时端口转发被分到新端口 | `ssh.forward.ephemeralRecreated` · SSH 转发已在新的本地端口上创建 / `portChanged` | toast | 转发面板有新端口，但不推 | 保留 | 端口号变了，用户可能还拿着旧号。 |
| `src/ui/overlays/SshConnect.tsx:517` | 连接前抓转发快照失败 | `ssh.forward.snapshotFailed` | toast | 否 | 保留 | 同 auto-reconnect。 |
| `src/ui/overlays/SshConnect.tsx:246` | 刷新 `~/.ssh/config` 成功 | `ssh.config.loaded` · SSH 配置已刷新 | toast | 是：列表刷新 | 删除 | 成功且列表就是反馈。 |
| `src/ui/overlays/SshConnect.tsx:255` | 读 `~/.ssh/config` 失败 | `ssh.config.load_failed` · 无法读取 ~/.ssh/config | toast | 对话框内可显示 | 改为内联静默状态 | 人就在这个对话框里。 |
| `src/ui/overlays/SshConnect.tsx:270` | 读已保存主机失败 | `ssh.profile.load_failed` · 无法读取已保存的 SSH 主机 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/overlays/SshConnect.tsx:315` | 删除已保存主机失败 | `ssh.profile.remove_failed` · SSH 主机删除失败 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/overlays/SshConnect.tsx:349` | 私钥选择器打不开 | `ssh.identity_picker.failed` · 无法打开私钥选择器 | toast | 同上 | 改为内联静默状态 | 人在表单里。 |
| `src/ui/overlays/SshConnect.tsx:363` | 证书选择器打不开 | `ssh.certificate_picker.failed` · 无法打开证书选择器 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/overlays/SshConnect.tsx:377` | Jump 私钥选择器打不开 | 同 349 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/overlays/SshConnect.tsx:391` | Jump 证书选择器打不开 | 同 363 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/overlays/SshConnect.tsx:604` | 保存 SSH 主机失败 | `ssh.profile.save_failed` · SSH 主机保存失败 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/modules/session/new-terminal-directory.ts:25` | 系统目录选择器失败 | `terminal.directory_picker.failed` · 无法选择目录 | toast | 否 | 保留 | 选择器在系统层，失败后画面无变化。 |
| `src/modules/terminal/lib/terminal-action-registry.ts:98` | 粘贴时系统拒读剪贴板 | `term.paste_clipboard_denied` · 系统拒绝了剪贴板读取 | toast | 否 | 保留 | 没贴进去。 |
| `src/modules/terminal/lib/terminal-export-file.ts:20` | 导出时缓冲区空 | `term.export.empty` · 没有可导出的内容 | toast | 否 | 保留 | 保存框都不会出现。 |
| `src/modules/terminal/lib/terminal-export-file.ts:36` | 导出写入成功 | `term.export.saved` · 已导出终端输出 | toast | 是：保存对话框 | 删除 | 截断时改留 warning toast。 |
| `src/modules/terminal/lib/terminal-export-file.ts:46` | 导出写入失败 | `term.export.failed` · 无法导出终端输出 | toast | 否 | 保留 | 对话框已关，写盘失败必须说。 |
| `src/modules/terminal/lib/terminal-export-file.ts:62` | 无 buffer 对象 | 同 :20 | toast | 否 | 保留 | 与空缓冲区同一条。 |
| `src/ui/lib/open-in-editor.ts:20` | 打不开配置的外部编辑器 | `diff.toast.editor_not_found` · 未找到编辑器 | toast | 否 | 保留 | 系统没打开任何窗口。 |
| `src/ui/DiffPanel.tsx:599` | 复制 hunk | 成功 `diff.toast.hunk_copied` · 已复制这段改动；失败 `copy_failed` | toast | 否 | 保留 | 剪贴板无反馈。 |
| `src/ui/TerminalExitBanner.tsx:42` | 复制连接诊断 | 成功 `connection.diagnostics.copied` · 连接诊断已复制；失败 `toast.copy_error` | toast | 否 | 保留 | 剪贴板无反馈。 |
| `src/modules/ssh/ForwardingPanel.tsx:183` | 复制转发 endpoint | `clipboard.copy_success` / `clipboard.copy_failed` | toast | 否 | 保留 | 剪贴板无反馈。 |
| `src/ui/FileExplorer.tsx:121` | 复制路径 | 同上 | toast | 否 | 保留 | 剪贴板无反馈。 |
| `src/ui/FileExplorer.tsx:142` | 单文件下载完成 | `explorer.download.complete` · 下载完成 | toast | 否（单文件不走传输列表） | 保留 | 写盘结果只有这里。 |
| `src/ui/FileExplorer.tsx:150` | 单文件下载失败 | `explorer.download.failed` · 下载失败 | toast | 否 | 保留 | 失败。 |
| `src/ui/FileExplorer.tsx:186` | 文件夹下载已入队 | `explorer.download.batch_queued` · 下载已加入队列 | toast | 是：传输面板 | 删除 | 队列自己会动。 |
| `src/ui/FileExplorer.tsx:193` | 文件夹下载准备失败 | `explorer.download.failed` | toast | 否 | 保留 | 没入队。 |
| `src/ui/FileExplorer.tsx:395` | 拖放准备失败 | `explorer.drop.failed` · 无法准备拖放的项目 | toast | 有 sr-only `dropMessage` | 保留 | 可视反馈不够，错误细节在 toast。 |
| `src/ui/FileExplorer.tsx:425` | 上传选文件对话框失败 | `explorer.upload.failed` · 上传失败 | toast | 否 | 保留 | 选择器失败。 |
| `src/ui/FileExplorer.tsx:432` | 选完文件后入队失败 | `explorer.drop.failed` / `mutation.prepare_failed` | toast | 否 | 保留 | 没入队。 |
| `src/ui/FileExplorer.tsx:451` | 选完文件夹后入队失败 | 同上 | toast | 否 | 保留 | 同上。 |
| `src/ui/FileExplorer.tsx:491` | 远程 home 打不开，改显示 `/` | `explorer.remote_home_failed` · 无法打开远程主目录，已改为显示根目录 | toast | 是：列表已是 `/` | 删除 | 列表内容就是结果。 |
| `src/ui/FileExplorer.tsx:734` | 远程 mkdir/rename/delete 准备失败 | `explorer.mutation.prepare_failed` · 无法开始这项操作 | toast | 对话框还在 | 改为内联静默状态 | 人在突变对话框里。 |
| `src/ui/FileExplorer.tsx:784` | 命名突变准备失败 | 同上 | toast | 同上 | 改为内联静默状态 | 同上。 |
| `src/ui/FileExplorer.tsx:815` | 外部编辑远程文件准备失败 | `preview.editor.external_remote_open_failed` · 无法为外部编辑准备远程文件 | toast | 否 | 保留 | 没打开编辑器。 |
| `src/ui/FileExplorer.tsx:917` | 多选下载已入队 | `explorer.download.batch_queued` | toast | 是：传输面板 | 删除 | 同 186。 |
| `src/ui/FileExplorer.tsx:925` | 多选下载准备失败 | `explorer.download.failed` | toast | 否 | 保留 | 没入队。 |
| `src/ui/file-explorer/use-direct-upload.ts:96` | 直传选文件对话框失败 | `explorer.upload.failed` | toast | 否 | 保留 | 选择器失败。 |
| `src/ui/file-explorer/use-direct-upload.ts:173` | 直传完成 | `explorer.upload.complete` · 上传完成 | toast | 是：进度条结束 | 删除 | 进度条归零就是完成。预览可留在传输卡。 |
| `src/ui/file-explorer/use-direct-upload.ts:195` | 直传失败 | `explorer.upload.failed` | toast | 进度条会停 | 保留 | 失败原因不在进度条上。 |
| `src/modules/ssh/transfer-store.ts:198` | 非批量上传完成 | `explorer.upload.complete` + 预览 action | toast | 是：传输面板 | 删除 | 完成态和预览按钮已在传输卡。 |
| `src/ui/TerminalViewChrome.tsx:140` | SSH 未就绪时往终端拖文件 | `term.drop.upload` / `term.drop.ssh_not_ready` · SSH 尚未就绪 | toast | 否 | 保留 | 文件没入队。可改等连上再传，那就删这条。 |
| `src/ui/TerminalViewChrome.tsx:178` | 往远程终端拖文件已入队 | `term.drop.upload` + 已加入 N 个文件 | toast | 是：传输面板 | 删除 | 队列自己会动。 |
| `src/ui/TerminalViewChrome.tsx:186` | 终端拖放失败 | `term.drop.upload` / `explorer.drop.failed` 或 `term.drop.no_cwd` | toast | 否 | 保留 | 没入队。无 cwd 这条尤其要说。 |
| `src/ui/FilePreview.tsx:1285` | 预览里打开远程外部编辑失败 | `preview.editor.external_remote_open_failed` | toast | 编辑器工具条无变化 | 保留 | 没打开。 |
| `src/modules/ssh/remote-external-edit.ts:47` | 会话已关，外部编辑同步停 | `preview.editor.external_remote_sync_failed` + session_closed_body | toast | 否（窗口可能在别的应用） | 保留 | 自动上传停了，本地副本还在。 |
| `src/modules/ssh/remote-external-edit.ts:54` | 同步失败，会话还在 | 同上 + 打开远程预览 action | toast | 否 | 保留 | 同上。 |
| `src/modules/ssh/remote-external-edit.ts:88` | 远程文件不是可编辑文本 | `preview.editor.error_unsupported` · Tunara 无法安全编辑这个文件 | toast | 否 | 保留 | 没打开。 |
| `src/modules/ssh/remote-external-edit.ts:143` | 外部编辑冲突或读本地失败 | `conflict_title` 或 `sync_failed` | toast | 否 | 保留 | 自动上传停了。 |
| `src/modules/ssh/remote-external-edit.ts:157` | 外部编辑器已打开 | `preview.editor.external_remote` / `external_remote_hint` · 保存后会传回远程主机 | toast | 是：编辑器窗口 | 删除 | 窗口就是反馈。 |

### 横幅 / 遮罩 / 恢复条

| 文件:行号 | 触发 | 文案 | 类型 | 别处能否看到 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/ui/TerminalExitBanner.tsx:72` | PTY 退出 | `terminal.exited.ok/failed/disconnected` · 进程已退出 / SSH 连接已中断 | 横幅 | 侧栏未读、gbar | 需要设计 | 死窗格需要「重启/重连」按钮。全局计数进「需要你」，按钮留在窗格。不要再 toast。 |
| `src/ui/TerminalExitBanner.tsx:185` `PtyErrorBanner` | PTY/SSH 打开失败 | `pty.error.title` / `ssh.error.title` | 横幅 | toast 已重复 | 改为内联静默状态 | 这是死窗格的下一步，不是全局喇叭。删掉配套 toast。 |
| `src/ui/TerminalExitBanner.tsx:291` `ConnectingOverlay` | 等待 PTY/SSH 打开 | `connection.phase.*` · 正在连接主机 等 | 内联状态 | 标题栏设备状态也有 phase | 改为内联静默状态 | 窗格占位，不是通知。可更轻。 |
| `src/ui/SessionRemediationNotice.tsx:9` | SSH 需要凭据 / 主机密钥 / 重连 | `remediation.*.title` · 需要 SSH 凭据 等 | 横幅 | gbar 也有 SSH 失败 | 并入「需要你」 | 持续要人。当前窗格可留一个按钮，不要第二套文案。 |
| `src/modules/terminal/lib/pty-bridge.ts:767` | 后端要 TOFU | `ssh.hostKey.title` · 验证主机密钥 | 模态 | 连接 phase=`verifyingHostKey` | 保留模态 | 要指纹决定，toast 不够。 |
| `src/modules/terminal/lib/pty-bridge.ts:784` | 后端要键盘交互 | `ssh.keyboardInteractive.title` · 需要认证 | 模态 | 否 | 保留模态 | 要回答。 |

### Dock / OSC

| 文件:行号 | 触发 | 文案 | 类型 | 别处能否看到 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/ui/terminal-attention.ts:15` 被 `sessions.ts:676` 调用 | 后台 Agent 等待确认 | 无文案，Informational 弹跳 | Dock | gbar「待确认」、会话卡徽章 | 并入「需要你」 | 弹跳改为「需要你」>0 且失焦时的 OS 投影，不再单独按事件弹。 |
| `src/ui/terminal-attention.ts:15` 被 `sessions.ts:754` 调用 | 后台命令 ≥15s 结束 | 无文案 | Dock | 命令 toast + 未读 | 并入「需要你」 | 同上。 |
| `src/ui/TerminalView.tsx:557` | xterm `onBell`，窗口失焦且设置开 | 无文案 | Dock | 终端响铃本身 | 需要设计 | BEL 不是「需要你」。要么跟设置走只弹跳、不进侧栏，要么关掉产品弹跳只留终端铃。 |
| `src/app/useDockBadge.ts:13-18` | 失焦时未读数；聚焦清零 | 数字角标 | Dock | 侧栏未读点 | 并入「需要你」 | 角标 = 「需要你」的数量，不是第三套计数。 |
| `src/ui/terminal-attention.ts:23` `emitTerminalNotification` | OSC 9 / 99 / 777 | 解析后丢弃 | 系统通知 | — | 删除（已空） | 注释写明不再 toast/弹跳。解析留下以免序列漏到屏幕。 |
| `src/ui/overlays/settings/TerminalSettings.tsx:128` | 用户开关 | `settings.appearance.bell_notification` · 完成通知 | 设置 | — | 保留 | 控制失焦弹跳。文案仍写「Agent 完成将触发 Dock 弹跳」，与代码不完全一致（完成走 toast，等待确认才弹跳）。改文案。 |

### 已在处理

| 文件:行号 | 触发 | 文案 | 类型 | 别处能否看到 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/ui/SshSuggestionBar.tsx:16` | 本地会话里敲了 `ssh host` | `ssh.suggest.title` · 用内置 SSH 打开 … | 提示条 | 否 | 已在处理 | 其他线程删除/重做。 |
| `src/ui/PreviewSuggestionBar.tsx:13` | 终端输出里扫到预览 URL | `preview.suggest.title` · 要在 Tunara 里预览 … | 提示条 | Inspector 也有预览建议 | 已在处理 | 同上。 |
| `src/ui/ReviewChangesBar.tsx:12` | Agent 改了文件 | `review.suggest.title` · N 个文件有改动 | 提示条 | Changes 页、gbar 查看改动 | 已在处理 | 同上。 |
| `src/ui/GlobalAgentBar.tsx:238` | 有待处理 / 运行中 / 可恢复会话 | `gbar.title` · 会话动态；`gbar.count.attention` · N 待处理 | 侧栏条 | 会话卡状态点 | 已在处理 | 目标形态就是「需要你」一行。 |

### Inspector / 传输 / 终端内联

| 文件:行号 | 触发 | 文案 | 类型 | 别处能否看到 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `src/ui/InspectorPanel.tsx:392` | 自动建议切到 Changes/Preview/Transfers/Files | `inspector.suggest.changes` · 有未审阅的改动 等 | 提示条 | 三条终端提示条、传输角标 | 删除 | 第四条建议条。用户已经打开 Inspector。 |
| `src/ui/TransferCenter.tsx:66` | 传输开始/进度/终态 | `transfer.announcement.*` | 内联状态（sr-only） | 传输列表 | 改为内联静默状态 | 给读屏，不是产品喇叭。留着。 |
| `src/ui/TransferCenter.tsx:178` | 上传残留路径 | `transfer.residue` | 内联状态 | 否 | 改为内联静默状态 | 卡片内部告警，对。不要升 toast。 |
| `src/ui/TransferCenter.tsx:195` | 恢复传输失败 | `transfer.recovery.error.*` | 内联状态 | 否 | 改为内联静默状态 | 同上。 |
| `src/ui/terminal-attention.ts:42` | SSH 输入队列满，2s 节流 | `terminal.inline.input_queue_full` · 远程输入队列已满… | 终端内联写入 | 否 | 改为内联静默状态 | 写进该 PTY，对。不要 toast。 |
| `src/ui/TerminalView.tsx:439` | 打开失败时往终端写红字 | `pty.error.inline` · [PTY 错误：…] | 终端内联写入 | 横幅重复 | 删除 | 横幅已有同一句话。 |

### 内联状态（不是出口，列出来避免漏）

这些已经在面板里。不要升成 toast，也不进「需要你」（除非用户离开后工作没做完）。

| 文件:行号 | 触发 | 文案 | 类型 | 建议 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `src/ui/FilePreview.tsx:1105-1131` | 保存/脏 | `preview.editor.saved/unsaved` · 已保存 / 尚未保存 | 内联状态 | 改为内联静默状态 | 脏点足够。没有「已保存」toast，对。 |
| `src/ui/FilePreview.tsx:1150` | 冲突/保存失败/结果未知 | `preview.editor.conflict_title` 等 | 内联状态 | 改为内联静默状态 | 人在编辑器里。 |
| `src/ui/FilePreview.tsx:1186` | 关未保存草稿 | `preview.editor.close_warning` | 内联状态 | 改为内联静默状态 | 确认条，不是通知。 |
| `src/ui/FilePreview.tsx:1585` | 读文件失败 | `preview.read_failed` | 内联状态 | 改为内联静默状态 | 预览区自己说。 |
| `src/ui/PreviewPanel.tsx:185-220` | 预览/隧道状态 | `inspector.preview.status.*` / `failed_help` | 内联状态 | 改为内联静默状态 | 面板内部。 |
| `src/ui/FileExplorer.tsx:1155` | 读目录失败 | `explorer.read_dir_failed` | 内联状态 | 改为内联静默状态 | 行内错误。 |
| `src/ui/FileExplorer.tsx:1206` | SSH 断了还在看缓存 | `explorer.remote_disconnected` | 内联状态 | 并入「需要你」 | 断线是持续要人；explorer 条可留重连按钮。 |
| `src/modules/ssh/ForwardingPanel.tsx:193,239` | 转发错误 | `forwarding.error.*` | 内联状态 | 改为内联静默状态 | 人在转发页。 |
| `src/ui/SessionCard.tsx:16,527` | 未读点、待确认徽章 | `gbar.tag.confirmation` · 待确认 | 内联状态 | 并入「需要你」 | 会话行可留圆点，文案不要和第二处打架。 |
| `src/ui/Titlebar.tsx:455,1179` | 纯净模式会话名 / 设备身份 | 会话名、连接 phase | 内联状态 | 改为内联静默状态 | 铬，不是喇叭。 |
| `src/ui/overlays/settings/AppSettings.tsx:29` | 用户打开应用页 | `settings.app.updates.*` | 内联状态 | 改为内联静默状态 | 检查更新写在该页，对。 |

### 模态确认（用户手势拉起，不是推送）

| 文件:行号 | 触发 | 类型 | 建议 | 理由 |
| --- | --- | --- | --- | --- |
| `src/ui/TransferCenter.tsx:99` 等 | 取消/覆盖传输 | 模态 | 保留模态 | 要是/否。 |
| `src/ui/file-explorer/upload-preflight.ts` | 覆盖远程文件 | 模态 | 保留模态 | 要是/否。 |
| `src/modules/terminal/lib/terminal-action-registry.ts` 粘贴确认 | 大粘贴 | 模态 | 保留模态 | 要是/否。 |

---

## 执行顺序

### 0. 无风险，直接删（不改信息架构）

这些调用拿掉以后，用户仍能从当前屏幕看出结果。

1. `src/ui/overlays/SshConnect.tsx:246` — SSH 配置已刷新
2. `src/ui/FileExplorer.tsx:186` — 文件夹下载已入队
3. `src/ui/FileExplorer.tsx:917` — 多选下载已入队
4. `src/ui/TerminalViewChrome.tsx:178` — 终端拖放已入队
5. `src/modules/ssh/remote-external-edit.ts:157` — 外部编辑器已打开
6. `src/state/sessions.ts:659` — 后台 Agent「已完成」
7. `src/modules/ssh/transfer-store.ts:198` — 上传完成 toast
8. `src/ui/file-explorer/use-direct-upload.ts:173` — 直传完成 toast
9. `src/ui/overlays/CommandPalette.tsx:204` — 没有需要处理的会话
10. `src/app/useKeybindings.ts:135` — 同上
11. `src/ui/TerminalView.tsx:454` — 与 `PtyErrorBanner` 重复的 PTY toast
12. `src/ui/FileExplorer.tsx:491` — 远程 home 失败（列表已是 `/`）
13. `src/state/sessions.ts:977` — 「仅 SSH 可再开窗口」（应改禁用菜单）
14. `src/modules/terminal/lib/terminal-export-file.ts:36` — 导出成功（截断除外）
15. `src/ui/InspectorPanel.tsx:392` — Inspector 建议条
16. `src/ui/TerminalView.tsx:439` — 终端红字，与横幅重复
17. `src/ui/Toast.tsx` 退出动画、进度条（留悬停暂停）
18. `pty-bridge.ts:47` 在 `status === "saved"` 时的成功 toast

### 1. 收口到「需要你」（等侧栏线程的一行就位）

把持续态从 toast/横幅/gbar 挪走：

- Agent 等待确认、Agent 失败退出、SSH 失败/断开、后台命令失败、explorer 远程断开
- Dock 角标改镜像「需要你」计数
- Dock 弹跳只在「需要你」>0 且失焦时响一次（BEL 除外，见下）
- `SessionRemediationNotice` 的全局文案并进去；当前窗格只留按钮

### 2. 对话框内错误改内联

`SshConnect.tsx` 里 255–604 的 load/save/picker 失败，以及 explorer 突变准备失败：写在表单 `role="alert"`，不要 toast。

### 3. 需要设计再动

- **关运行中会话的二次确认**（`sessions.ts:524/1001`）：toast 当确认不可靠。候选：会话行上的内联「再点一次」，或短模态。
- **退出横幅**：死窗格的重启/重连按钮留下；不要同时 toast。
- **BEL 弹跳**：不是「需要你」。单独决定是否还要 OS 注意力。
- **更新提醒去向**：现在 toast 已克制。若「需要你」允许非会话条目，再搬过去。

### 不做的

- 不要把剪贴板成功改成内联。剪贴板没反馈。
- 不要恢复 OSC 9/99/777 的 toast/弹跳。
- 不要新增系统通知通道。
- 不要在传输面板已有卡片时再为完成态加 toast。

---

## 计数核对

Toast `addToast` 生产调用：73。  
其中建议删除 24、保留 28、并入「需要你」4、改内联 9、需要设计 2（关闭确认两处）、已在处理 0。  
（`sessions.ts:699/746` 按「并入需要你」计，成功分支在理由里要求删。）

非 toast 行 39：已在处理 4、并入「需要你」12、改内联 13、删除 3、保留模态 6、需要设计 2（退出横幅、BEL）。

合计 112 行。建议列加总：删除 32 + 保留 toast 28 + 并入「需要你」16 + 内联 22 + 模态 6 + 已在处理 4 + 需要设计 4 = 112。
