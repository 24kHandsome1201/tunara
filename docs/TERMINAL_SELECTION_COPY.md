# 终端选区复制 / 粘贴（⌘C / 右键，macOS 风格）

## 背景与现状

探查确认当前终端（xterm.js）的选区/复制能力：

- ❌ 拖选**不自动复制**，无 `onSelectionChange` 监听
- ❌ 无右键菜单（容器 `containerRef` 上无 `onContextMenu`）
- ❌ 无 ⌘C 拦截（标准复制键未接管）
- ❌ 无 tmux 风格 copy mode
- ✅ 已有 OSC 52 剪贴板写入（远程程序 → 本机剪贴板，受 `terminalClipboardWrite` 开关管）
- ✅ 已有命令块复制（`copyBlockOutput/Command/CommandAndOutput`，走 UI 按钮）
- ✅ 已有 paste protection（`registerTerminalPasteProtection`，括号粘贴防护）

## 设计决策（已定）

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 复制触发 | **仅 ⌘C / 右键显式复制**，不做拖选自动复制 | macOS 原生习惯；拖选即复制会静默覆盖系统剪贴板，误选就丢原内容 |
| ⌘C 冲突 | **有选区才复制，无选区放行 SIGINT** | 主流终端标准行为；保住终端里 ⌘C 中断的肌肉记忆 |
| 右键菜单 | **仅复制 + 粘贴两项** | 克制，复用现有 `ctx-item` 样式，贴合轻量定位 |
| copy mode | **不做** | tmux copy mode 是 TUI 范式；GUI 用鼠标天然解决，工作量大且偏题 |

## 关键约束（来自真实代码，非二手）

1. **`attachCustomKeyEventHandler` 已被占用**
   `TerminalView.tsx:171` 已 attach 了 search + blocks 的处理：
   ```ts
   term.attachCustomKeyEventHandler((e) => search.handleCustomKeyEvent(e) && blocks.handleCustomKeyEvent(e));
   ```
   xterm 只支持**一个** custom key handler。⌘C 拦截必须**插进这条链**，不能再 attach。
   注意现有链是 `A && B` 短路语义——返回 `false` 表示"xterm 不要处理这个键"。新逻辑要保持这个返回值语义。

2. **复制方向不受 `terminalClipboardWrite` 管**
   那个开关语义是 **OSC 52**（远程程序写本机剪贴板，安全敏感）。本地用户主动 ⌘C 是显式意图，**不该被它 gate**。两套逻辑分开。

3. **粘贴要走现有 paste protection**
   `registerTerminalPasteProtection` 已处理括号粘贴模式。右键"粘贴"应调用 `term.paste(text)`，让保护逻辑自然生效，**不要**绕过它直接 `pty.write`。

4. **不与命令块复制 / quickSelect 冲突**
   命令块复制走 UI 按钮、quickSelect 走独立 overlay，都不碰原生选区。新的 ⌘C/右键只作用于 `term.getSelection()` 的原生拖选，互不干扰。

## 实现方案

### 1. ⌘C 拦截：插入现有 key handler 链

新建 `src/modules/terminal/lib/terminal-copy.ts`：

```ts
import type { Terminal } from "@xterm/xterm";

/**
 * ⌘C：有选区则复制并吞掉事件（不触发 SIGINT）；无选区则放行给终端（Ctrl+C 中断）。
 * 返回 false 表示已处理、xterm 不应再处理此键（与现有 handler 链语义一致）。
 */
export function handleCopyKeyEvent(term: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;
  // macOS ⌘C；同时兼容习惯用 Ctrl+Shift+C 的用户（可选，按需保留）
  const isCmdC = e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c";
  if (!isCmdC) return true;
  const sel = term.getSelection();
  if (!sel) return true; // 无选区 → 放行（让 ⌘C/Ctrl+C 走中断）
  navigator.clipboard.writeText(sel).catch(() => {});
  return false; // 有选区 → 吞掉，已复制
}
```

接入 `TerminalView.tsx:171`，**插在链最前**（复制优先，且不影响 search/blocks 的非 ⌘C 判断）：

```ts
term.attachCustomKeyEventHandler((e) =>
  handleCopyKeyEvent(term, e) && search.handleCustomKeyEvent(e) && blocks.handleCustomKeyEvent(e),
);
```

> 短路正确性：`handleCopyKeyEvent` 对非 ⌘C 一律返回 `true`，链继续；命中复制返回 `false`，后两个 handler 不执行 —— 正是我们要的（复制时不应触发 search/blocks 的键逻辑）。

### 2. 右键菜单：复制 + 粘贴

容器加 `onContextMenu`。复用现有 `ctx-item` 样式（`tokens.css:329`）与项目已有的菜单组件（若有 `ContextMenu` 组件则复用，否则用与 SessionCard 右键同款）。

行为：
- **复制**：`term.getSelection()` 有值才 enabled；点击 → `navigator.clipboard.writeText(sel)`。
- **粘贴**：`navigator.clipboard.readText()` → `term.paste(text)`（经 paste protection）。

菜单定位用鼠标坐标；点击空白/Esc 关闭（复用现有菜单关闭逻辑）。

伪代码（挂在 `TerminalView` 返回的容器层，或 `TerminalViewChrome`）：

```ts
const onContextMenu = (e: React.MouseEvent) => {
  e.preventDefault();
  const term = termRef.current;
  if (!term) return;
  openContextMenu({
    x: e.clientX, y: e.clientY,
    items: [
      { label: t("term.copy"), disabled: !term.getSelection(),
        onClick: () => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(()=>{}); } },
      { label: t("term.paste"),
        onClick: async () => { try { const txt = await navigator.clipboard.readText(); if (txt) term.paste(txt); } catch {} } },
    ],
  });
};
```

> macOS 上原生右键默认是"选词"。我们 `preventDefault` 接管为菜单。若想保留"右键选词"，可走 xterm 的 `rightClickSelectsWord: true` + 改用 Ctrl+右键 出菜单——但**不建议**，菜单是 GUI 用户更强的预期。

### 3. 选区视觉（已就绪，无需改）

选区背景由主题 `selectionBackground` 提供，且被强调色覆写（`getTerminalTheme`）。各预设已校验可辨。复制功能上线后选区**可见性已满足**，不需额外改色。

## 不做（明确边界）

- 拖选自动复制（决策已砍）
- tmux 风格键盘 copy mode（决策已砍）
- 中键粘贴（X11 primary selection，macOS 无此范式）
- 复制时的格式化/去 ANSI（`getSelection()` 已返回纯文本）

## i18n

新增文案键：`term.copy`、`term.paste`。按项目 i18n 约定加到各语言包（与现有 `agent.status.*` 同文件）。

## 落地步骤

1. 新建 `terminal-copy.ts`，导出 `handleCopyKeyEvent`。
2. 改 `TerminalView.tsx:171`，把 `handleCopyKeyEvent` 插入 key handler 链最前。
3. 容器加 `onContextMenu`，复用现有菜单组件 + `ctx-item` 样式，两项：复制 / 粘贴。
4. 加 i18n 文案键。
5. 单测 `terminal-copy`：有选区 ⌘C 返回 false + 写剪贴板；无选区 ⌘C 返回 true（放行）；非 ⌘C 返回 true。

## 验收清单

- [ ] 选中终端文本按 ⌘C → 复制到系统剪贴板，**不触发** SIGINT。
- [ ] 未选中按 ⌘C / Ctrl+C → 正常发中断信号给前台进程。
- [ ] 右键有选区 → "复制"可点；右键无选区 → "复制"灰显。
- [ ] 右键"粘贴" → 文本经 paste protection 写入终端（括号粘贴模式生效）。
- [ ] 不影响 search（⌘F）、命令块复制、quickSelect。
- [ ] OSC 52 远程复制仍受 `terminalClipboardWrite` 开关管，与本地 ⌘C 互不影响。
- [ ] 运行中 agent（如 Claude Code）里选中文本 ⌘C 复制不打断 agent。
```
