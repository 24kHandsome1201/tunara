# Conduit 代码审查与修复报告

日期：2026-06-21

## 1. 总体结论

项目整体方向清晰，核心是 Tauri v2 加 React，加 xterm.js 终端，加 Git 和文件审查面板。主要风险集中在四类地方：终端视图过大导致维护成本高，分屏与会话状态存在真实使用中的可见性问题，移动端窄屏交互不够稳，文件预览和 diff 输出有不必要的大块数据传输。

本次已完成低风险、可验证的修复，并补充回归测试。更大规模的架构拆分建议放到下一轮做，特别是 `src/ui/TerminalView.tsx` 的拆分。

## 2. 已修复的问题

### 2.1 架构与状态管理

`TerminalView.tsx` 当前约 701 行，混合了 xterm 初始化、PTY IO、搜索 UI、agent 检测、键盘事件和生命周期同步。这个文件会继续变成风险热点。本次没有贸然大拆，先修复周边状态漏洞。

会话在分屏模式下切换时，新的 active session 可能没有出现在任何 pane 里。现在 `setActive` 和 `addSession` 会保证当前会话在分屏中可见。

关闭 active session 时，旧逻辑更容易跳到列表第一个会话。现在优先选择相邻会话，体验更符合标签页常见行为。

删除会话时会清理 `gitNonce`、启动标记和关闭确认状态，减少长期运行后的脏状态。

初始化恢复会话时，如果用户在持久化数据加载完成前新建了会话，旧逻辑可能覆盖用户刚创建的会话。现在会合并恢复数据和当前会话。

### 2.2 用户体验

窄屏下侧栏和审查面板增加了遮罩，点击遮罩可以关闭，避免内容层叠后无处可点。

侧栏和面板宽度增加了响应式上限，设置窗口增加了 `maxWidth`，小屏幕不会横向溢出。

Escape 现在可以关闭覆盖层、移动端侧栏和移动端面板，同时尽量不抢终端内部的 Escape。

命令面板新增了三个常用动作：在当前目录新建终端，刷新当前 Git 状态，关闭当前会话。

命令面板搜索结果变化时会夹住选中索引，避免 Enter 触发空项或越界项。

分屏快捷键切换现在只在 paneA 和 paneB 之间切换，避免跳到分屏外的隐藏会话。

侧栏搜索时禁用拖拽排序，避免用过滤后的索引改乱完整会话列表。搜索无结果时会显示空状态。

### 2.3 性能优化

文件预览后端现在最多读取 256 KiB 文本预览内容，并返回 `truncated` 标记。之前前端只展示一小段，后端和 IPC 仍可能传输最多 10 MB 文本。

Markdown 预览解析加入 `useMemo`，避免无关状态变更时反复解析同一份内容。

Git diff 输出增加了更严格的字节上限判断，减少超限 patch 的额外字符串增长。

切换目录时先清空远端 Git 状态，避免 UI 短暂显示上一个目录的 ahead 或 behind 信息。

### 2.4 稳定性与可访问性

外观设置加载时会校验 theme、accent、cursorStyle、terminalTheme、fontSize、sidebarWidth、panelWidth。异常 localStorage 值会回到安全默认值。

设置 setter 也增加了防御式校验，减少调试或异常调用带来的非法 UI 状态。

Toast 的退出计时器现在会在卸载时清理，降低快速切换或重复渲染时的泄漏风险。

新增 `prefers-reduced-motion` 支持，对系统减少动态效果偏好的用户更友好。

## 3. 修改文件

| 文件 | 主要改动 |
| --- | --- |
| `src/state/ui.ts` | 外观设置校验，宽度和字号夹取，新增直接设置侧栏和面板可见性的方法 |
| `src/state/sessions.ts` | 分屏可见性保障，关闭相邻会话，清理 per-session 状态 |
| `src/app/useInit.ts` | 恢复会话时合并当前状态，布局恢复使用直接 setter |
| `src/app/App.tsx` | 窄屏遮罩，响应式宽度，侧栏和面板 overlay 层级优化 |
| `src/app/useKeybindings.ts` | Escape 关闭覆盖层和移动端面板 |
| `src/ui/MainArea.tsx` | 切换目录时清空 stale remote 状态 |
| `src/ui/overlays/CommandPalette.tsx` | 新增常用命令，修复选中索引和滚动定位 |
| `src/ui/Sidebar.tsx` | 搜索时禁用拖拽，新增空状态 |
| `src/ui/FilePreview.tsx` | Markdown memo，展示截断提示 |
| `src/modules/fs/fs-bridge.ts` | ReadResult 增加 truncated 字段 |
| `src-tauri/src/modules/fs/file.rs` | 文本预览读取上限，二进制探测保留 |
| `src-tauri/src/modules/git/mod.rs` | diff 输出上限更严格 |
| `src/ui/Toast.tsx` | 清理退出计时器 |
| `src/ui/overlays/Settings.tsx` | 设置窗口小屏 maxWidth |
| `src/styles/globals.css` | 减少动态效果支持 |
| `tests/project-review-regressions.test.mjs` | 新增 4 个回归测试 |

## 4. 验证结果

已执行：

```bash
node --experimental-strip-types --test tests/*.test.mjs
```

结果：21 个测试全部通过。

受限项：当前容器没有 `node_modules`，`pnpm` 需要联网激活，且 `cargo`、`rustc` 不存在。因此完整 `pnpm build`、`pnpm typecheck`、`cargo test` 没有完成。直接运行 `tsc --noEmit` 时主要失败点是缺少 `react`、`zustand`、`@tauri-apps/*`、`@xterm/*` 等依赖类型。

## 5. 下一轮建议

1. 拆分 `TerminalView.tsx`，建议拆成 `useTerminalInstance`、`usePtyBridge`、`useTerminalSearch`、`useAgentTracking` 和展示组件。

2. 给 Rust 侧补单元测试，覆盖 `fs_read_file` 的文本截断、二进制探测、UTF-8 边界，以及 `git_diff` 的超限场景。

3. 给关键 UI 行为补浏览器级测试，尤其是移动端 overlay、命令面板、分屏切换和关闭会话。

4. 增加虚拟列表或分组懒渲染，未来会话数量较多时侧栏能保持稳定帧率。
