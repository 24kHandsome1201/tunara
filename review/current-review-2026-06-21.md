# Conduit 当前分支复核版审查

日期: 2026-06-21
分支: `fix/conduit-fixes-2026-06-21`
基线: `main`
范围: 当前工作区, GPT Pro 新增 review 输入, 本机 build/test/diff-check

## 结论

当前工作区已经处理第一轮合入阻断和一批 P0/P1 行为与设计问题。源码门禁通过:

- `git diff --check`: 通过。
- `pnpm build`: 通过。
- `pnpm test`: 通过, Node 30 个测试, Rust 5 个测试。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`: 通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: 通过。
- `pnpm tauri dev` 临时端口启动: 通过编译并打开 PTY, 最近一次使用 1426 端口。

仍不应把它直接当成稳定发布完成:

- Tauri 进程和 PTY 已验证, 但窗口视觉和控件树检查被 macOS Apple Event 权限拦截。
- Homebrew cask 还没有基于真实发布 DMG 回填 sha256, 不能直接宣称发版产物已完成。
- `TerminalView.tsx` 文件尺寸热点已消除, 但 PTY 初始化和 agent lifecycle 仍是后续可继续拆的深层状态机。

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
- `Settings`: CLI tab 展示全部 CLI 的 installed, missing, error 和 source 状态, 不再静默吞掉 `resolve_all_bins` 失败; 同时补充安装数量摘要和重新检测入口。
- `Settings`: CLI tab 下不显示“恢复默认”, 避免用户在不可见上下文里重置外观。
- `ContextMenu`: 增加 `role="menu"`, `role="menuitem"`, `role="separator"` 和 Arrow/Home/End/Enter/Space 键盘支持。
- `ContextMenu`: 阴影改用 `--shadow-menu` token。
- `ContextMenu`: 增加统一 icon slot, 文件、目录和会话右键菜单项不再是纯文字列表。
- `shared`: `SearchIcon` 和 `CloseIcon` 从重复 SVG 中抽到共享组件, 搜索框和关闭按钮不再各自维护同形状 path。
- `Sidebar`/`FileExplorer`/`sessions`: 移除 "启动所有 Agent" 入口和 `launchAllAgents`, 避免产品漂移成 agent launcher。
- `MainArea`: 状态栏路径做中间缩略, 右侧 Git/Agent 信息加收缩策略。
- `DiffPanel`: 文件行从松散卡片改为列表分隔线, 信息密度更接近开发者工具。
- `Titlebar`: tab 关闭按钮 hit target 从 16px 增到 20px, 折叠侧栏时 tab 区补左间距, 右侧按钮 gap 收窄。
- `Sidebar`: 新建按钮和目录 header 对齐收口, 快捷键标注改成 badge 样式。
- `Sidebar`: 移除底部固定“会话 + 数字”统计栏, 减少低价值 chrome, 把垂直空间还给会话列表。
- `Sidebar`/`SessionCard`: 会话列表补 `role="list"`/`listitem`, roving `tabIndex`, ArrowUp/Down/Home/End 键盘导航和可见焦点环, 过滤或折叠目录后仍按当前可见会话移动。
- `CommandPalette`: 批量关闭改走 store 统一 action, 运行中会话用一次集中确认反馈, 同时去掉选中项左侧竖条。
- `CommandPalette`: section 分组时保留全局索引, 渲染期不再用 `ranked.indexOf(cmd)` 做 O(n²) 反查。
- `DiffPanel`: 文件状态 badge 增加 R/? 区分, embedded 模式去掉重复刷新入口, `remoteLabel` 删除死参数。
- `FileExplorer`: 面包屑改用 `›`, 搜索结果路径智能缩略, 文件大小列固定右对齐。
- `ContextMenu`: 增加轻量进入动画。
- `Settings`: 终端主题卡片改成自适应 grid, 强调色选中态不再膨胀。
- `Settings`: 主题缩略图去掉 traffic-light 和 2px 微线条, 改为侧栏/主区/accent 组成的块面预览。
- `AgentStatusBar`: 完成态停留时间和淡出时间缩短。
- `Sidebar`/`FileExplorer`/`DiffPanel`/`Settings`/`CommandPalette`: 隐藏滚动条的纵向列表增加 `scroll-fade-y` 边界阴影, 侧栏使用 `scroll-fade-sidebar` 匹配玻璃底色。
- `MainArea`: 分屏按钮改成 16px 左右/上下专用 glyph, 并补 `aria-label`, 小尺寸下方向不再只靠 tooltip 区分。
- `ContextMenu`: 菜单项支持显式 `id`, separator key 由相邻项派生, 不再用渲染索引作为 key。
- `DiffPanel`/`FilePreview`/`Settings`: diff 行、Markdown block/inline/list 和主题缩略图线条改为内容派生 key, 避免稳定列表继续依赖数组索引。

### 文档

- `docs/设计-右键菜单与批量启动Agent.md`: 重写为右键菜单基础设施文档, 删除批量启动 Agent 规格。
- `docs/实现文档-功能补全.md`: 删除“已合入当前 main”的误导表述, 改为候选分支口径。

### 结构收口

- 新增 `src/modules/agent/registry.ts`, 前端 agent 名称、命令识别和 Settings CLI 列表共用同一事实源。
- 新增 `src/modules/agent/registry-data.json`, 前端 registry 和 Rust resolver 共用 agent code, UI 名称、识别命令和 CLI 探测命令配置。
- `TerminalThemeName` 改由 `TERMINAL_THEME_NAMES` 数组派生, localStorage 校验不再手写另一份枚举。
- `src-tauri/src/modules/resolver/mod.rs` 读取共享 agent registry JSON, 并增加 Rust 单测锁住 `CP -> gh`, `CR -> cursor` 等跨语言映射。
- `sessions` store 统一管理单个会话和目录批量关闭确认态的过期 timer, UI 组件不再各自启动 3 秒清理 timer。
- release metadata 已收口: package, Tauri, Cargo, Cargo.lock 和 Homebrew cask 都对齐 `1.0.2`; Homebrew URL/homepage 对齐当前 GitHub owner; cask zap 路径对齐 `dev.conduit.app`; 回归测试禁止 `PLACEHOLDER_SHA256` 和旧 owner/bundle id 回流。
- `TerminalSearchBar`, `useTerminalSearch`, `useTerminalRuntimeSync`, `terminal-buffer-read`, `terminal-command`, `terminal-instance`, `terminal-output-buffer`, `observeTerminalResize` 和 `scanTerminalInputBuffer` 已从大组件抽出, `TerminalView.tsx` 降到 482 行, `Sidebar.tsx` 降到 338 行, 并新增 line-count 回归测试防止回涨。
- `terminal-input-buffer`: 终端输入逐字符解析改成纯函数, 覆盖跨 chunk 输入、退格、Ctrl-U、多行提交、OSC title 和 CSI 方向键噪声。
- `agent-lifecycle`: 新增 `detectAgentCommand` 行为测试, 锁住首 token 识别、ANSI 清理和非首 token 不误判。
- `App`: 左右栏 resize handle 合并成参数化 `ResizeHandle`, pointer capture 和 document listener 生命周期只维护一份。
- `useInit`: 复用同一个 `getCurrentWindow()` 结果处理 fullscreen、resize 和 close-requested, 避免窗口生命周期接线分叉。
- `Toast`: 宽度改为 260 到 340px 的响应式范围, 左侧 accent 从独立占位竖条改为 inset 标记, 长 subtitle 使用单行截断。
- `tokens`: `--font-ui` 增补 BlinkMacSystemFont, Segoe UI 和 Roboto, Linux/WebKitGTK 字体回退更稳。
- `AgentBadge`: 直接复用 `AGENT_CIRCLE_STYLES` token map, 移除 render-time 构造的重复 styleMap。
- `⌘0` 字号重置改用 `DEFAULT_SETTINGS.fontSize`, 不再硬编码 14。
- `Toast` 退出状态改用 ref 防重复 dismiss 旧闭包。
- `deriveTitle`: 副标题和 `SessionCard` diff badge 共用同一次新增/删除统计, 不再重复 reduce。
- `styles`: 删除 0 字节的 `src/styles/tokens.ts`, 保留实际入口 `tokens.css`。
- `CI`: 增加 Rust `rustfmt` 和 `clippy -D warnings` 门禁, 并修复当前 clippy 发现的手写 clamp 和 Git diff tuple 聚合可读性问题。

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
- 当前分支再次使用临时 1422 启动: `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1422","devUrl":"http://127.0.0.1:1422"}}'`。
- 本次 1422 启动编译完成并运行 `target/debug/conduit`, 日志再次出现 `hooks listener started` 和 `pty opened id=1`。
- `nc -z 127.0.0.1 1422` 在启动期间成功, 退出后已释放。
- Computer Use 读取 `Conduit` 和运行应用列表仍失败, 错误仍为 `Apple event error -1743`。
- 当前 HEAD `cce53a6` 再次使用临时 1423 启动: `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1423","devUrl":"http://127.0.0.1:1423"}}'`。
- 本次 1423 启动编译完成并运行 `target/debug/conduit`, 日志再次出现 `hooks listener started` 和 `pty opened id=1`。
- `nc -z 127.0.0.1 1423` 在启动期间成功, 退出后已释放。
- `osascript` 读取 `Conduit` 窗口位置/大小仍失败, 错误为 `-1719`, 原因是 `osascript` 不允许辅助访问。
- 当前未提交拆分后再次使用临时 1424 启动: `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1424","devUrl":"http://127.0.0.1:1424"}}'`。
- 本次 1424 启动编译完成并运行 `target/debug/conduit`, 日志再次出现 `hooks listener started` 和 `pty opened id=1`。
- `nc -z 127.0.0.1 1424` 在启动期间成功, 退出后已释放。
- `osascript` 读取 `Conduit` 窗口位置/大小仍失败, 错误为 `-1719`, 原因仍是 `osascript` 不允许辅助访问。
- 当前 HEAD `304993c` 再次使用临时 1425 启动: `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1425","devUrl":"http://127.0.0.1:1425"}}'`。
- 本次 1425 启动编译完成并运行 `target/debug/conduit`, 日志再次出现 `hooks listener started` 和 `pty opened id=1`。
- Computer Use 读取 `Conduit` 窗口状态失败, 错误为 `Apple event error -1743`。
- `screencapture -x /tmp/rail-conduit-1425.png` 被安全策略拒绝, 原因是全屏截取可能包含无关敏感窗口内容, 需要用户明确提供截图或授权更窄的视觉验证路径。
- `nc -z 127.0.0.1 1425` 在退出后已释放。
- 当前未提交 CI/测试补强后再次使用临时 1426 启动: `pnpm tauri dev --config '{"build":{"beforeDevCommand":"vite --host 127.0.0.1 --port 1426","devUrl":"http://127.0.0.1:1426"}}'`。
- 本次 1426 启动编译完成并运行 `target/debug/conduit`, 日志再次出现 `hooks listener started` 和 `pty opened id=1`。
- `nc -z 127.0.0.1 1426` 在启动期间成功, 退出后已释放。

仍需人工或授权后验证:

- 启动 app。
- 打开终端并输入。
- 切换分屏。
- 打开设置页。
- 打开右键菜单并用键盘操作。
- 窄窗口检查 sidebar/panel overlay。

### P1: release artifact sha 未闭环

证据:

- `package.json` 是 `1.0.2`。
- `src-tauri/tauri.conf.json` 是 `1.0.2`, identifier 是 `dev.conduit.app`。
- `src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 已对齐 `1.0.2`。
- `homebrew/conduit.rb` URL/homepage 已指向当前远端 owner `24kHandsome1201/conduit`。
- cask zap 路径已对齐 `dev.conduit.app`。
- cask 目前使用 `sha256 :no_check`, 避免提交假 checksum, 但这不是最终发布证明。

建议:

- 真实 release DMG 上传后, 下载发布资产并用实际 sha256 替换 `:no_check`。
- 用该 GitHub release asset 反查 URL 和 checksum 后, 再宣布 Homebrew cask 可发布。

### P2: 深层状态机拆分

当前状态:

- `python3 /Users/mawei/.agents/skills/check/scripts/audit_signals.py --root /Users/mawei/code/pi5x/rail`: `FILE SIZE HOTSPOTS` 通过, 当前没有 500 行以上源码文件。
- `src/ui/TerminalView.tsx`: 已从 746 行降到 482 行, resize observer、输入 buffer parser、搜索状态、可见/外观同步、xterm 初始化、输出批量写入、buffer 读取和命令噪声判断均已拆出。
- `src/ui/Sidebar.tsx`: 已从 493 行降到 338 行, 当前可接受, 后续主要是 drag/reorder 可独立抽 hook。

仍可后续拆分:

- `usePtyBridge`
- `useAgentLifecycleTracking`
- Sidebar drag/reorder 和 context menu action builder

## GPT Pro review 校准

`review/code-review-2026-06-21.md` 中仍成立或已处理:

- B-1 重命名 Escape: 已修。
- B-2 暗色 accent fallback: 已修。
- D-1 Agent 列表分散: 已修, 前端和 Rust resolver 共用 `registry-data.json`, 并有 Node/Rust 回归锁定。
- D-2 terminal theme 校验重复: 已修, type 和校验共用 `TERMINAL_THEME_NAMES`。
- D-5 PanelResizeHandle 和 SidebarResizeHandle 重复: 已修, 合并到通用 `ResizeHandle`。
- D-6 useInit 重复调用 getCurrentWindow: 已修, fullscreen 和 close-requested 共用同一个 `win`。
- D-8 remoteLabel 死代码: 已修。
- S-2 SVG 图标重复: 已修, `SearchIcon` 和 `CloseIcon` 共用 `src/ui/shared.tsx`。
- S-4 空 `tokens.ts`: 已修, 删除未被引用的 0 字节文件。
- S-5 数组索引 key: 已修, 右键菜单、diff 预览、Markdown 预览和设置缩略图都改为显式 id 或内容派生 key。
- P-1 SessionCard 重复 reduce 计算: 已修, `deriveTitle` 返回 `totalAdded` 和 `totalRemoved`。
- P-3 CommandPalette `indexOf`: 已修, section 分组直接携带 `globalIdx`。

已失效或降级:

- B-3 useEffect 缺 deps: 当前代码已补依赖。
- D-7 customTitle 不持久化: 当前代码已持久化。
- B-4 closeSessionsInDir 旧快照: 已修, 目录关闭和命令面板批量关闭都走 `closeSessions`。
- B-5 Toast stale closure: 已修。

`review/design-review.md` 中已处理:

- Agent 状态条遮挡终端内容。
- unread 圆点和关闭按钮抢位。
- Agent 圆形图标 hardcoded color。
- CLI tab 内容空洞和错误状态不可见。
- ContextMenu 可访问性不足。
- DiffPanel 文件列表过度卡片化。
- Tab close hit target 偏小。
- Sidebar 对齐和快捷键 badge 不统一。
- Sidebar 底部“会话”统计栏信息密度过低。
- CommandPalette 选中竖条和 section 对齐。
- FileExplorer 面包屑、搜索路径和文件大小列。
- ContextMenu 缺少进入动画。
- ContextMenu 菜单项缺少图标。
- Settings 终端主题卡片固定宽度。
- Settings 主题缩略图细节过碎。
- 分屏活跃面板 outline 视觉噪声。
- Toast 固定 260px 和左侧 accent 竖条挤压内容。
- Linux 字体回退链不够保险。
- 隐藏滚动条后缺少滚动提示。
- 侧栏会话列表键盘导航覆盖不足。

仍建议后续视觉 QA:

- 侧栏文字对齐。
- 状态栏在极窄窗口下的最终表现。
- 终端 padding 8px 后的密度。
- 设置页终端主题 grid 在真实窗口里的最终换行效果。

## 当前建议

当前工作区可以进入下一轮合入复核, 但不要跳过 Tauri 视觉 smoke。源码测试已经绿, Tauri 启动和 PTY 初始化也可跑通, 但终端类桌面应用仍必须用真实窗口确认窗口层级、分屏、菜单和窄窗口状态。
