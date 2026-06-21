# 设计文档: 右键菜单系统 + 批量启动 Agent

> 状态: 待实现
> 涉及文件: 6 个（1 新建 + 5 修改），无后端改动
> 预估工作量: 4-6 小时

---

## 1. 背景

Conduit 当前的操作入口只有 hover 小按钮（新建终端、关闭）和 Command Palette。随着功能增加（在编辑器打开、复制路径、批量启动 Agent），hover 按钮已经放不下。右键菜单是桌面应用的标准操作入口，需要作为基础设施补上。

"批量启动 Agent"是第一个依赖右键菜单的新功能: 用户在侧栏目录组或 FileExplorer 目录上右键，一键在该目录下同时启动 claude/codex/droid/devin 四个 session。

---

## 2. 设计目标

- 一个通用的 `ContextMenu` 组件，所有区域复用
- 三个触发区域: Sidebar 目录组头、SessionCard、FileExplorer 条目
- 视觉上与现有 overlay 一致（同配色体系，暗色模式自动适配）
- 不影响现有 hover 按钮（两者并存）

---

## 3. ContextMenu 组件规格

### 3.1 文件位置

新建 `src/ui/ContextMenu.tsx`

### 3.2 接口定义

```typescript
interface MenuItem {
  label: string;          // 显示文字
  action: () => void;     // 点击回调
  danger?: boolean;       // 危险操作（红色文字）
  disabled?: boolean;     // 禁用态（灰色，不可点）
}

interface ContextMenuProps {
  items: MenuItem[];
  position: { x: number; y: number };  // 鼠标坐标
  onClose: () => void;
}
```

支持分割线: `items` 数组中传 `null` 表示分割线。所以实际类型是:

```typescript
type MenuEntry = MenuItem | null;

interface ContextMenuProps {
  items: MenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
}
```

### 3.3 视觉规格

```
┌──────────────────────────┐
│  在此目录新建终端     ⌘T  │  ← 普通条目
│  启动所有 Agent           │
│  ─────────────────────── │  ← 分割线
│  在编辑器中打开           │
│  复制路径                 │
│  ─────────────────────── │
│  关闭全部会话             │  ← danger 红色
└──────────────────────────┘
```

**尺寸与间距:**

| 属性 | 值 | 对应 token |
|------|----|-----------|
| 最小宽度 | 180px | 硬编码 |
| 最大宽度 | 260px | 硬编码 |
| 条目高度 | 32px | 硬编码 |
| 条目左右内边距 | 12px | `--sp-3` |
| 条目文字大小 | 13px | `--fs-body` |
| 条目文字字体 | `--font-ui` | 系统字体 |
| 分割线上下间距 | 4px | `--sp-1` |
| 菜单圆角 | 8px | `--r-input` |
| 菜单背景 | `--c-bg-white` | 白/深底 |
| 菜单边框 | `1px solid --c-border-2` | |
| 菜单阴影 | `0 8px 30px rgba(0,0,0,0.12)` | 介于 card 和 overlay 之间 |
| 暗色模式阴影 | `0 8px 30px rgba(0,0,0,0.4)` | |

**状态样式:**

| 状态 | 背景 | 文字颜色 |
|------|------|---------|
| 默认 | transparent | `--c-text-2` |
| hover | `--c-bg-hover` | `--c-text-primary` |
| danger 默认 | transparent | `--c-error` |
| danger hover | `--c-error-bg-light` | `--c-error` |
| disabled | transparent | `--c-text-6` |
| active (按下) | opacity 0.8 | 同 hover |

**hover 必须用 CSS :hover 实现**（遵守 Conduit 编码规则，禁止 JS handler）。在 `tokens.css` 中新增:

```css
.ctx-item { background: transparent; color: var(--c-text-2); transition: background var(--duration-fast) ease, color var(--duration-fast) ease; }
.ctx-item:hover { background: var(--c-bg-hover); color: var(--c-text-primary); }
.ctx-item:active { opacity: 0.8; }
.ctx-item-danger { color: var(--c-error); }
.ctx-item-danger:hover { background: var(--c-error-bg-light); color: var(--c-error); }
.ctx-item-disabled { color: var(--c-text-6); pointer-events: none; }
```

### 3.4 行为规格

1. **定位:** fixed 定位，以鼠标坐标为锚点
2. **边界检测:** 渲染后测量菜单尺寸，如果超出窗口右边界则向左展开（x - width），如果超出下边界则向上展开（y - height）
3. **关闭触发:**
   - 点击菜单外任意位置 → 关闭
   - Escape 键 → 关闭
   - 点击任一条目 → 执行 action 后关闭
   - 窗口 resize → 关闭
4. **动画:** 无入场动画（菜单响应要求即时）
5. **层级:** `z-index: 9999`（高于所有 overlay）
6. **事件阻止:** `onContextMenu` handler 中 `e.preventDefault()` 阻止浏览器默认右键菜单

### 3.5 实现要点

- 用 `useEffect` + `addEventListener("mousedown", ...)` 监听外部点击
- 用 `useEffect` + `addEventListener("keydown", ...)` 监听 Escape
- 用 `useRef` + `getBoundingClientRect()` 在首次渲染后做边界修正
- 用 React Portal（`createPortal`）渲染到 `document.body`，避免被父容器 overflow 裁切

---

## 4. 触发区域与菜单条目

### 4.1 Sidebar 目录组头 (DirGroupHeader)

**触发方式:** 在 `DirGroupHeader` 外层 div 上加 `onContextMenu`

**菜单条目:**

| 条目 | action 逻辑 | danger |
|------|------------|--------|
| 在此目录新建终端 | `useSessionsStore.getState().newTerminalInDir(dir)` | 否 |
| 启动所有 Agent | 见 §5 | 否 |
| 在编辑器中打开 | `openInEditor(externalEditor, dir)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(dir)` | 否 |
| — 分割线 — | | |
| 关闭全部会话 | `useSessionsStore.getState().closeSessionsInDir(dir)` | **是** |

**修改文件:** `src/ui/Sidebar.tsx`

### 4.2 Sidebar SessionCard

**触发方式:** 在 `SessionCard` 外层 div 上加 `onContextMenu`

**菜单条目:**

| 条目 | action 逻辑 | danger |
|------|------------|--------|
| 在编辑器中打开 | `openInEditor(externalEditor, session.dir)` | 否 |
| 复制目录路径 | `navigator.clipboard.writeText(session.dir)` | 否 |
| — 分割线 — | | |
| 关闭会话 | `onClose()` | **是** |

**修改文件:** `src/ui/SessionCard.tsx`

需要新增 `onContextMenu` prop:

```typescript
interface SessionCardProps {
  // ...现有 props
  onContextMenu?: (e: React.MouseEvent) => void;  // 新增
}
```

然后在 Sidebar.tsx 中传入 handler，因为 SessionCard 不知道 `externalEditor` 和菜单状态。

### 4.3 FileExplorer 目录行和文件行

**触发方式:** 在每个目录/文件的 `<button>` 上加 `onContextMenu`

**目录行菜单:**

| 条目 | action 逻辑 | danger |
|------|------------|--------|
| 在此目录新建终端 | `useSessionsStore.getState().newTerminalInDir(fullPath)` | 否 |
| 启动所有 Agent | 见 §5，dir = 该目录完整路径 | 否 |
| 在编辑器中打开 | `openInEditor(externalEditor, fullPath)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(fullPath)` | 否 |

**文件行菜单:**

| 条目 | action 逻辑 | danger |
|------|------------|--------|
| 在编辑器中打开 | `openInEditor(externalEditor, fullPath)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(fullPath)` | 否 |

**修改文件:** `src/ui/FileExplorer.tsx`

---

## 5. "启动所有 Agent" 功能规格

### 5.1 行为

点击后，在指定目录下创建 4 个独立 session，每个自动执行对应的 agent CLI 命令:

```
claude → session 1
codex  → session 2
droid  → session 3
devin  → session 4
```

### 5.2 实现

在 `src/state/sessions.ts` 中新增一个 store action:

```typescript
launchAllAgents: (dir: string) => void;
```

实现逻辑:

```typescript
launchAllAgents: (dir) => {
  const agents = ["claude", "codex", "droid", "devin"];
  for (const cmd of agents) {
    get().addSession(createSession(dir, { pendingInput: cmd }));
  }
  // 确保目录组展开
  const collapsedDirs = useUIStore.getState().collapsedDirs;
  if (collapsedDirs[dir]) {
    useUIStore.getState().toggleDirCollapsed(dir);
  }
},
```

### 5.3 关键细节

- **不做 preflight 预检测:** 如果某个 agent CLI 未安装，session 会自然显示 `command not found`。用户能看到，不需要额外弹窗。
- **agent 列表硬编码:** `["claude", "codex", "droid", "devin"]`。不做配置化。
- **pendingInput 机制已存在:** `TerminalView.tsx:420-426` 在 PTY ready 后 300ms 自动写入命令并回车。各 PTY 独立，不互相干扰。
- **焦点:** `addSession` 每次都会设 `activeSessionId`，最终焦点落在最后一个（devin）。
- **目录组展开:** 如果该目录组当前折叠，自动展开，让用户能看到新创建的 4 个 session。

---

## 6. 右键菜单状态管理

### 6.1 方案

**不用 store**。右键菜单是瞬态 UI，用组件内 `useState` 管理即可。

在 Sidebar.tsx 和 FileExplorer.tsx 各自维护一个状态:

```typescript
const [contextMenu, setContextMenu] = useState<{
  items: MenuEntry[];
  position: { x: number; y: number };
} | null>(null);
```

触发时:

```typescript
onContextMenu={(e) => {
  e.preventDefault();
  setContextMenu({
    items: [...],
    position: { x: e.clientX, y: e.clientY },
  });
}}
```

关闭时:

```typescript
setContextMenu(null);
```

渲染:

```tsx
{contextMenu && (
  <ContextMenu
    items={contextMenu.items}
    position={contextMenu.position}
    onClose={() => setContextMenu(null)}
  />
)}
```

---

## 7. 文件改动清单

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/ui/ContextMenu.tsx` | **新建** | 通用右键菜单组件（约 80 行） |
| `src/styles/tokens.css` | 修改 | 新增 `.ctx-item` / `.ctx-item-danger` / `.ctx-item-disabled` 三组 hover 类 |
| `src/state/sessions.ts` | 修改 | 新增 `launchAllAgents(dir)` action |
| `src/ui/Sidebar.tsx` | 修改 | DirGroupHeader + SessionCard 区域加 `onContextMenu` handler |
| `src/ui/SessionCard.tsx` | 修改 | 新增 `onContextMenu` prop 透传 |
| `src/ui/FileExplorer.tsx` | 修改 | 目录行/文件行加 `onContextMenu` handler |

**无后端（Rust）改动。** 所有需要的 Tauri command 已存在:
- `openInEditor` → `src/modules/editor/open.ts`
- `createSession` + `pendingInput` → `src/state/sessions.ts`
- 剪贴板 → `navigator.clipboard.writeText()` (Web API)

---

## 8. 实现顺序

严格按以下顺序，每步可独立验证:

### Step 1: ContextMenu 组件 + CSS 类

1. 在 `tokens.css` 末尾添加 `.ctx-item` 系列样式
2. 新建 `src/ui/ContextMenu.tsx`，实现完整组件
3. 验证: 临时在任意位置硬编码一个 `<ContextMenu>` 确认渲染正常

### Step 2: sessions store 新增 launchAllAgents

1. 在 `src/state/sessions.ts` 的 store 接口中新增 `launchAllAgents`
2. 实现 action 逻辑
3. 验证: 在浏览器控制台手动调用 `useSessionsStore.getState().launchAllAgents("~")` 确认创建 4 个 session

### Step 3: Sidebar 目录组头右键菜单

1. 在 `Sidebar.tsx` 中引入 `ContextMenu`、`openInEditor`、`useUIStore`
2. 在 `DirGroupHeader` 的外层 div 加 `onContextMenu`
3. 管理 `contextMenu` state
4. 验证: 右键目录组头，菜单出现，每个条目可点击

### Step 4: SessionCard 右键菜单

1. 在 `SessionCard.tsx` 新增 `onContextMenu` prop
2. 在 `Sidebar.tsx` 中传入 handler
3. 验证: 右键会话卡片，菜单出现

### Step 5: FileExplorer 右键菜单

1. 在 `FileExplorer.tsx` 中引入 `ContextMenu`、`openInEditor`、`useUIStore`、`useSessionsStore`
2. 目录行和文件行分别加 `onContextMenu`
3. 验证: 右键目录行/文件行，菜单出现，条目正确

---

## 9. 验收检查清单

- [ ] 右键 Sidebar 目录组头 → 菜单出现，5 个条目
- [ ] 右键 Sidebar SessionCard → 菜单出现，3 个条目
- [ ] 右键 FileExplorer 目录行 → 菜单出现，4 个条目
- [ ] 右键 FileExplorer 文件行 → 菜单出现，2 个条目
- [ ] "启动所有 Agent" → 创建 4 个 session，各自执行 claude/codex/droid/devin
- [ ] "在编辑器中打开" → 调起系统设置的外部编辑器
- [ ] "复制路径" → 剪贴板写入正确路径
- [ ] "关闭全部会话" → 红色文字，点击后关闭该目录所有 session
- [ ] 菜单外点击 → 菜单关闭
- [ ] Escape → 菜单关闭
- [ ] 菜单靠近窗口右边界 → 向左展开
- [ ] 菜单靠近窗口下边界 → 向上展开
- [ ] 暗色模式下菜单样式正常（背景、文字、hover、阴影）
- [ ] 现有 hover 按钮（+新建、×关闭）正常工作，未受影响

---

## 10. 不做的事

- 键盘导航右键菜单（上下键选择条目）
- 嵌套子菜单
- 右键菜单中的文件写操作（新建/重命名/删除/粘贴文件）
- agent 列表可配置化
- agent CLI 安装预检测
- 快捷键标签（除"在此目录新建终端"可选显示 ⌘T 外）
