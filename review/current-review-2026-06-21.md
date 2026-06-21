# Conduit 当前分支复核版审查

日期: 2026-06-21
分支: `fix/conduit-fixes-2026-06-21`
基线: `main`
范围: 当前工作区, GPT Pro 新增 review 输入, 本机 build/test/diff-check

## 结论

当前工作区已经处理第一轮合入阻断和一批 P0/P1 行为与设计问题。源码门禁通过:

- `git diff --check main`: 通过。
- `pnpm build`: 通过。
- `pnpm test`: 通过, Node 22 个测试, Rust 4 个测试。
- `pnpm tauri dev` 临时端口启动: 通过编译并打开 PTY。

仍不应把它直接当成稳定发布完成:

- Tauri 进程和 PTY 已验证, 但窗口视觉和控件树检查被 macOS Apple Event 权限拦截。
- release 配置仍有版本、owner 和 bundle id 漂移。
- `TerminalView.tsx` 和 `Sidebar.tsx` 仍是结构热点, 需要后续拆分。

## 本轮已修

### 合入证据

- 删除外部目录生成的 `review/conduit-review-fixes.patch`。
- 重写 `review/review-fixes-2026-06-21.md`, 明确当前分支事实来源。
- 保留 GPT Pro 输入文档为参考, 不把它们原样当作当前分支结论。

### 行为 bug

- `SessionCard`: Escape 取消重命名时同步调用 `stopRenaming()`, 避免编辑框重新弹出。
- `index.html`: 暗色首屏 accent fallback 对齐 `DEFAULT_SETTINGS.accent`, 避免首屏闪色。
- `open_in_editor`: Rust 后端调用 `expand_tilde(&path)`, 修复 `~` 目录无法被外部编辑器打开的问题。
- `TerminalView`: `pty.write`, `pty.resize`, pending input timer 和 teardown 全部处理 Promise 失败, 避免 PTY 关闭竞态造成 unhandled rejection。

### 设计和交互

- `AgentStatusBar`: 从绝对定位浮层改为终端 pane 内的固定状态行, 不再遮挡终端顶部输出。
- `SessionCard`: 移除右侧独立 unread 圆点, unread 状态回到左侧状态点, 不再和关闭按钮抢位。
- `AgentBadge`/`SessionCard`: Agent 圆形图标改用 `--c-agent-*` token, dark mode 下颜色体系统一。
- `Settings`: CLI tab 展示全部 CLI 的 installed, missing, error 和 source 状态, 不再静默吞掉 `resolve_all_bins` 失败。
- `Settings`: CLI tab 下不显示“恢复默认”, 避免用户在不可见上下文里重置外观。
- `ContextMenu`: 增加 `role="menu"`, `role="menuitem"`, `role="separator"` 和 Arrow/Home/End/Enter/Space 键盘支持。
- `ContextMenu`: 阴影改用 `--shadow-menu` token。
- `Sidebar`/`FileExplorer`/`sessions`: 移除 "启动所有 Agent" 入口和 `launchAllAgents`, 避免产品漂移成 agent launcher。
- `MainArea`: 状态栏路径做中间缩略, 右侧 Git/Agent 信息加收缩策略。
- `DiffPanel`: 文件行从松散卡片改为列表分隔线, 信息密度更接近开发者工具。

### 文档

- `docs/设计-右键菜单与批量启动Agent.md`: 重写为右键菜单基础设施文档, 删除批量启动 Agent 规格。
- `docs/实现文档-功能补全.md`: 删除“已合入当前 main”的误导表述, 改为候选分支口径。

## 仍需跟进

### P0: 真实 Tauri 视觉 smoke 未完成

已有尝试:

- `osascript -e 'tell application "System Events" ...'` 失败, 原因是 `osascript` 不允许辅助访问。
- `pnpm tauri dev` 失败, Vite 报 `Port 1420 is already in use`。
- `lsof -nP -iTCP:1420 -sTCP:LISTEN` 显示 `node` PID 22275 正在监听 `[::1]:1420`。
- 未擅自 kill 端口占用进程。
- 使用临时 config 改到 1421 后, `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1421","devUrl":"http://127.0.0.1:1421"}}'` 编译通过并启动 `target/debug/conduit`。
- Tauri 日志显示 `hooks listener started` 和 `pty opened id=1`, 说明应用进程与 PTY 初始化链路可跑通。
- Computer Use 和 bundle id 方式读取窗口状态均失败, 错误为 `Apple event error -1743`。
- 临时 1421 端口在退出后已无监听, 本轮启动的 Tauri 进程已停止。机器上另有既存 `target/debug/conduit` 进程, 未处理。

仍需人工或授权后验证:

- 启动 app。
- 打开终端并输入。
- 切换分屏。
- 打开设置页。
- 打开右键菜单并用键盘操作。
- 窄窗口检查 sidebar/panel overlay。

### P1: release 配置漂移

证据:

- `package.json` 是 `1.0.2`。
- `src-tauri/tauri.conf.json` 是 `1.0.2`, identifier 是 `dev.conduit.app`。
- `src-tauri/Cargo.toml` 仍是 `1.0.1`。
- `homebrew/conduit.rb` 使用 `PLACEHOLDER_SHA256`。
- Homebrew cask URL 指向 `mawei/conduit`, updater endpoint 指向 `24kHandsome1201/conduit`。
- cask zap 路径使用 `com.conduit.app`, 和 Tauri identifier `dev.conduit.app` 不一致。

建议:

- 发版前统一 package, Cargo, Tauri, Homebrew 版本。
- 统一 GitHub owner。
- release 后回填真实 sha256。
- zap bundle id 使用实际 Tauri identifier。

### P1: Agent registry 还没有单一事实源

已移除最危险的 `launchAllAgents`, 但仍有多处 agent 信息:

- `agent-lifecycle.ts` 的命令识别。
- `Settings.tsx` 的 CLI 展示列表。
- Rust resolver 的 `resolve_all_bins` 映射。

建议:

- 后续建立 `agent-registry` 作为前端单一事实源。
- Rust resolver 映射保持同一顺序和同一 code/bin 对, 并增加测试锁住。

### P1: 命令面板批量关闭 busy session 反馈仍需收敛

问题:

- “关闭所有会话”和“关闭其他会话”仍是逐个调用 `closeSession`。
- 遇到 busy session 时, 第一次调用只是进入确认态, 用户反馈还不够集中。

建议:

- 增加 store 层 batch close action。
- 如果目标里有 busy session, 第一次只进入统一确认状态并显示 Toast, 第二次再批量关闭。

### P2: 架构热点

当前热点:

- `src/ui/TerminalView.tsx`: 仍超过 700 行。
- `src/ui/Sidebar.tsx`: 仍超过 500 行。

建议拆分:

- `useTerminalInstance`
- `usePtyBridge`
- `useTerminalSearch`
- `useAgentLifecycleTracking`
- Sidebar dir grouping, drag/reorder, context menu action builder

## GPT Pro review 校准

`review/code-review-2026-06-21.md` 中仍成立或已处理:

- B-1 重命名 Escape: 已修。
- B-2 暗色 accent fallback: 已修。
- D-1 Agent 列表分散: 部分处理, 移除批量启动, registry 后续做。
- D-2 terminal theme 校验重复: 仍建议后续统一。
- D-8 remoteLabel 死代码: 仍是低优先级清理项。
- P-3 CommandPalette `indexOf`: 仍是低优先级性能债。

已失效或降级:

- B-3 useEffect 缺 deps: 当前代码已补依赖。
- D-7 customTitle 不持久化: 当前代码已持久化。
- B-4 closeSessionsInDir 旧快照: 可优化, 但不是当前最高风险。
- B-5 Toast stale closure: 低风险, 不阻断。

`review/design-review.md` 中已处理:

- Agent 状态条遮挡终端内容。
- unread 圆点和关闭按钮抢位。
- Agent 圆形图标 hardcoded color。
- CLI tab 内容空洞和错误状态不可见。
- ContextMenu 可访问性不足。
- DiffPanel 文件列表过度卡片化。

仍建议后续视觉 QA:

- 侧栏文字对齐。
- 状态栏在极窄窗口下的最终表现。
- 终端 padding 8px 后的密度。
- 设置页终端主题卡片 grid 化。

## 当前建议

当前工作区可以进入下一轮合入复核, 但不要跳过 Tauri 视觉 smoke。源码测试已经绿, Tauri 启动和 PTY 初始化也可跑通, 但终端类桌面应用仍必须用真实窗口确认窗口层级、分屏、菜单和窄窗口状态。
