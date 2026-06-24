# Conduit 项目代码审查报告

> 审查范围：全部前端（React/TypeScript）+ 全部后端（Rust/Tauri）+ 配置/CI
> 审查时间：2026-06-21
> 版本：v1.2.0
> 编译检查：`pnpm typecheck` 通过 | `cargo check` 通过

---

## 一、严重问题 / Bug（必须修复）

### S1. Unix Socket 路径可预测，存在本地提权风险

**文件**: `src-tauri/src/modules/agent/hooks.rs:49`

```rust
let sock_path = PathBuf::from(format!("/tmp/conduit-hooks-{}.sock", std::process::id()));
```

路径使用 PID 构造，放在 `/tmp` 下，任何本地用户都可以读写。攻击者可以：
1. 预测 PID 并在 Conduit 启动前创建同名 socket（symlink race）
2. 向已存在的 socket 发送伪造的 agent lifecycle 事件
3. 触发任意 session 的 agent 状态变更

**修复建议**: 使用 `dirs::runtime_dir()` 或 `$XDG_RUNTIME_DIR`（如 `/run/user/1000/`），该目录权限为 `0700`，仅本人可访问。备选方案：创建时设置 socket 文件权限为 `0600`。

---

### S2. WebLinksAddon 打开 URL 无任何校验

**文件**: `src/ui/TerminalView.tsx:120`

```typescript
term.loadAddon(new WebLinksAddon((_event, uri) => { openUrl(uri); }));
```

终端输出中的任何 URL（包括恶意构造的）都会直接通过系统默认浏览器打开。xterm 的 WebLinksAddon 会匹配任意 URL scheme，包括 `file://`、`javascript:`（部分浏览器）、自定义 scheme 等。

恶意程序或脚本输出中可以嵌入诱导点击的链接。虽然需要用户点击，但没有任何确认或 scheme 白名单。

**修复建议**: 添加 scheme 白名单（`https://`、`http://`），拒绝或弹窗确认其他 scheme。

---

### S3. RwLock 全部使用 `expect()` —— 一个 panic 即导致全应用崩溃

**文件**: `src-tauri/src/modules/pty/mod.rs` 全文（第 41, 46, 54, 77, 83, 88, 115, 120, 136, 148, 165, 175, 197, 200, 207, 216 行）

PTY 模块中所有 `RwLock` 和 `Mutex` 的 `.lock()` / `.read()` / `.write()` 调用都使用 `expect("... lock poisoned")`。如果任何一个持锁线程 panic（例如 PTY spawn 异常），锁会被 poison，之后所有操作都会导致连锁 panic，整个应用崩溃。

```rust
.sessions.write().expect("pty sessions lock poisoned")
```

这在生产环境中是不可接受的 —— 一个 PTY 会话的异常不应导致其他会话全部不可用。

**修复建议**: 改用 `match` 处理 `PoisonError`，对 `RwLock` 可以用 `.into_inner()` 恢复，或使用 `parking_lot::RwLock`（不会 poison）。

---

## 二、中等问题（应该修复）

### M1. hooks socket 读取缓冲区固定 4096 字节，大 payload 会被截断

**文件**: `src-tauri/src/modules/agent/hooks.rs:72`

```rust
let mut buf = vec![0u8; 4096];
match conn.read(&mut buf) {
```

使用单次 `read()` 且缓冲区仅 4096 字节。如果 agent hook payload 超过此大小（例如包含长路径或额外字段），会被静默截断，导致 JSON 解析失败，事件丢失。

**修复建议**: 循环读取直到 EOF，或使用 `BufReader` + `read_to_string()`，加上合理的上限（如 64KB）。

---

### M2. DiffPanel 中 React key 存在碰撞风险

**文件**: `src/ui/DiffPanel.tsx:57-91`（`buildMiniDiffRows` 函数）

```typescript
if (line.startsWith("+")) {
  const key = `new:${newLine}:${line}`;  // 同一行号的相同内容 = 重复 key
```

key 的构造方式是 `prefix:lineNumber:lineContent`。如果 diff 中同一行号出现相同内容（多个 hunk 有相同行号的相同修改），key 会重复，导致 React 渲染异常。

**修复建议**: 在 key 中加入 hunk 序号或全局递增索引。

---

### M3. 使用已废弃的 `navigator.platform`

**文件**: `src/app/useKeybindings.ts:17-19`

```typescript
const isMac =
  navigator.platform.toLowerCase().includes("mac") ||
  navigator.userAgent.toLowerCase().includes("mac");
```

`navigator.platform` 已被 MDN 标记为废弃。Tauri 提供了 `@tauri-apps/plugin-os` 的 `platform()` 函数，项目已引入此依赖但此处未使用。

**修复建议**: 使用 `@tauri-apps/plugin-os` 的 `platform()` 或 `type()` 替换。

---

### M4. `keyring` 依赖已声明但未使用

**文件**: `src-tauri/Cargo.toml:43-45, 49-51`

```toml
[target.'cfg(target_os = "macos")'.dependencies]
keyring = { version = "3.6", default-features = false, features = ["apple-native"] }
```

在整个 Rust 代码库中没有找到任何 `use keyring` 或对 keyring crate 的引用。这增加了编译时间和二进制体积。

**修复建议**: 移除 `keyring` 依赖，或在注释中说明未来用途。

---

### M5. CHANGELOG.md 停留在初始状态

**文件**: `CHANGELOG.md`

内容仍标记为 `## Unreleased`，未记录 v1.0.0、v1.1.0、v1.2.0 的变更。对于已发布 GitHub Release 的项目，这会导致用户和贡献者无法追踪版本历史。

**修复建议**: 补充 v1.0.0 ~ v1.2.0 的变更记录。

---

### M6. CI 仅在 Ubuntu 上运行

**文件**: `.github/workflows/ci.yml:11`

```yaml
runs-on: ubuntu-22.04
```

Conduit 是一个跨平台桌面应用（macOS 是主要目标平台），但 CI 只在 Ubuntu 上编译和测试。macOS 特有的代码（vibrancy、titlebar overlay、keyring）从未在 CI 中被验证。

**修复建议**: 添加 macOS runner（至少做 `cargo check` + `cargo clippy`）。Windows runner 可选。

---

### M7. `tokio` 开启了过多 feature 但实际使用很少

**文件**: `src-tauri/Cargo.toml:29`

```toml
tokio = { version = "1", features = ["process", "io-util", "macros", "rt-multi-thread", "sync", "time"] }
```

在代码中 `tokio` 仅在 `resolver/mod.rs` 中被用于 `Command::output()`（async 进程执行）和 `timeout`。`rt-multi-thread` 由 Tauri 自行管理，`io-util` 和 `sync` 未在用户代码中使用。多余的 feature 增加编译时间。

**修复建议**: 精简为实际使用的 feature：`process`, `macros`, `time`。

---

### M8. PTY reader 线程中的 backpressure 硬重置可能丢失重要输出

**文件**: `src-tauri/src/modules/pty/session.rs`（reader 线程）

当累积数据超过 4MB 时执行硬重置（清空缓冲区）。如果 agent 正在输出大量代码或 diff，用户可能丢失关键信息且无任何提示。

**修复建议**: 在硬重置时向终端写入一条可见提示（如 `[output truncated]`），让用户知道发生了截断。

---

## 三、轻微问题 / 建议（可以改进）

### L1. 未使用 React.StrictMode

**文件**: `src/main.tsx:15-17`

```tsx
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
```

没有包裹 `<React.StrictMode>`。StrictMode 在开发模式下有助于发现副作用问题、过时 API 使用和意外的重渲染。

**说明**: 对于 xterm.js 终端组件，StrictMode 的 double-mount 行为可能导致问题（PTY 会 spawn 两次）。如果启用，需要在 TerminalView 中正确处理。可选择性地对非终端组件启用。

---

### L2. TerminalView 存在 ~400 行的单一 useEffect

**文件**: `src/ui/TerminalView.tsx:82-500+`

整个终端初始化（xterm 创建、addon 加载、OSC handler 注册、PTY spawn、input/output binding、snapshot scheduling）都在一个 useEffect 中。这使得：
- 阅读和维护困难
- 无法单独测试各个功能模块
- 局部修改需要理解整体流程

**建议**: 虽然由于初始化逻辑的强耦合性难以完全拆分，但可以考虑将 OSC handler 注册、snapshot 调度等逻辑抽取为独立函数，降低单一 useEffect 的认知负担。

---

### L3. 测试覆盖率极低

**文件**: 项目整体

前端仅有 3 个 Node.js 测试文件（`tests/*.test.mjs`），没有组件测试。后端有少量 `#[cfg(test)]` 模块，主要测试 pathspec 安全和 shell 脚本内容断言。

缺少的测试：
- 前端状态管理（Zustand store）
- 终端 agent 检测逻辑
- 会话恢复/持久化逻辑
- Git bridge 错误处理
- 文件系统操作边界情况

---

### L4. 硬编码中文 UI 文本，无 i18n 支持

**文件**: 多处（`DiffPanel.tsx`、`Sidebar.tsx`、`Settings.tsx`、`CommandPalette.tsx` 等）

所有用户可见文本都直接硬编码在组件中。例如：
- `"加载中…"`、`"二进制文件"`、`"文件过大"`
- `"新建终端"`、`"设置"`、`"搜索会话"`

如果未来需要支持多语言，改造成本较高。

---

### L5. Sidebar 中硬编码的平台快捷键标签

**文件**: `src/ui/Sidebar.tsx`

快捷键提示文本使用了 macOS 符号（⌘），在 Windows/Linux 上会产生困惑。

---

### L6. `expand_tilde` 不处理 `~username` 路径

**文件**: `src-tauri/src/modules/util.rs:10-23`

```rust
pub fn expand_tilde(path: &str) -> String {
    if path == "~" { ... }
    if let Some(rest) = path.strip_prefix("~/") { ... }
    path.to_string()  // ~username 原样返回
}
```

`~username` 格式的路径会原样返回而不展开。在 Unix 系统中这是一个合法的路径格式。但考虑到 Conduit 的使用场景（用户自己的终端），这种情况很少出现，优先级较低。

---

### L7. `grep-regex`、`grep-searcher`、`grep-matcher` 依赖可能过重

**文件**: `src-tauri/Cargo.toml:33-35`

这三个 crate 来自 ripgrep 生态，功能强大但体积较大。当前仅在 `fs/search.rs` 中用于文件搜索，实际使用场景仅做路径匹配。可考虑是否真的需要全套 grep 库。

---

## 四、前端 UI 相关问题（Design 阶段输入）

### UI1. 全部使用内联样式，无 CSS Modules / CSS-in-JS

**文件**: 所有组件

所有组件样式通过 `style={{}}` 内联传递。这导致：
- 无法使用伪类（`:hover`、`:focus`、`:active`）—— 目前依赖 CSS class（`.ctx-item:hover` 等）和少量全局 CSS
- 样式复用困难，大量重复的 `fontSize: "var(--fs-body)"`、`color: "var(--c-text-5)"` 等
- 无法实现条件动画或复杂选择器
- 增加 JS bundle 大小

**建议**: 项目已使用 CSS 自定义属性（tokens.css），可以更多地依赖 class 组合而非内联样式。

---

### UI2. Inspector Panel 最大宽度限制 45%

**文件**: `src/app/App.tsx`（resize handle 逻辑）

右侧面板最大宽度限制为窗口宽度的 45%。在超宽显示器（如 34 英寸 3440px）上，45% = 1548px 可能足够，但在标准 1080p 显示器上 45% = 864px，对于查看完整的 diff 内容可能不够。

**建议**: 考虑基于绝对像素值而非百分比设定上限，或允许用户自由调节。

---

### UI3. 初始加载无骨架屏/加载状态

**文件**: `src/app/App.tsx`、`src/app/useInit.ts`

应用启动时，在 session 恢复完成之前，界面直接渲染空状态。没有 loading skeleton 或启动动画。对于有大量 session 需要恢复的场景（snapshot 数据较大），会出现短暂的"空白闪烁"。

**建议**: 添加简单的启动加载状态（例如 logo + 进度条）。

---

### UI4. 平台快捷键显示不适配

**文件**: `src/ui/Sidebar.tsx`、`src/ui/overlays/CommandPalette.tsx`

UI 中显示的快捷键使用 macOS 符号（⌘、⇧），在 Windows/Linux 上：
- `⌘T` 应显示为 `Ctrl+T`
- `⌘W` 应显示为 `Ctrl+W`
- `⌘\` 应显示为 `Ctrl+\`

**建议**: 创建一个 `formatShortcut()` 工具函数，根据平台返回正确的快捷键文本。

---

### UI5. 暗色主题下某些状态颜色对比度不足

**文件**: `src/styles/tokens.css`（需要视觉验证）

部分使用 `color-mix()` 生成的半透明颜色，在深色背景上可能对比度不足（如 `var(--c-text-6)` 文本、disabled 状态按钮）。需要在实际暗色主题下验证 WCAG 对比度标准。

---

### UI6. 无键盘焦点可见指示

**文件**: 多处组件

除了 ContextMenu（有 `activeIndex` 高亮），大部分可交互元素（sidebar session card、settings 中的选项卡、面板切换按钮）缺少键盘焦点指示。对于键盘操作和无障碍访问（a11y）不够友好。

---

## 五、总结

| 级别 | 数量 | 状态 |
|------|------|------|
| 严重/Bug | 3 | 需立即修复 |
| 中等 | 8 | 应在下一版本修复 |
| 轻微/建议 | 7 | 可列入 backlog |
| 前端 UI | 6 | 交由 design 阶段评估 |

**整体评价**: 项目代码质量较好，TypeScript 和 Rust 编译均无错误/警告。架构分层清晰（modules/state/ui），PTY 管理和 agent 生命周期检测的设计比较成熟。主要风险集中在安全性（socket 路径、URL 打开）和健壮性（lock poison panic）方面。前端最大的架构债务是 TerminalView 的超大 useEffect 和全内联样式方案。
