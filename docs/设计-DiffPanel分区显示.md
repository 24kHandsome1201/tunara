# DiffPanel Staged/Unstaged 分区设计

## 设计原则

复用 Sidebar DirGroupHeader 的折叠交互模式, 复用现有 tokens 颜色体系。
分区 header 比文件行更轻, 不抢视觉焦点。staged 用 `--c-success` 色系标记, unstaged 用默认色, untracked 用 `--c-text-5` 灰色。

## 数据结构变更

`FileChange` 新增 `stage` 字段:

```typescript
export interface FileChange {
  path: string;
  status: string;      // "M" | "A" | "D" | "R" | "?"
  stage: "staged" | "unstaged" | "both" | "untracked";
  added: number;
  removed: number;
}
```

"both" 表示同一文件有 staged 和 unstaged 部分, 在两个分区中各出现一次。

## 分区 header 设计

```
┌──────────────────────────────────────┐
│ ▸  已暂存 · 3                        │  ← collapsed
├──────────────────────────────────────┤
│ ▾  未暂存 · 5                        │  ← expanded
│   ┌──────────────────────────────┐   │
│   │ M  src/ui/DiffPanel.tsx  ⤴ +12 −3 ▸ │
│   │ A  src/types.ts          ⤴ +8 −0  ▸ │
│   └──────────────────────────────┘   │
├──────────────────────────────────────┤
│ ▾  未追踪 · 2                        │
│   ┌──────────────────────────────┐   │
│   │ ?  docs/notes.md         ⤴       ▸ │
│   └──────────────────────────────┘   │
└──────────────────────────────────────┘
```

### Header 样式 (SectionHeader 组件)

复用 Sidebar DirGroupHeader 的交互模式:

- **容器**: `padding: 4px 8px`, `cursor: pointer`, hover 时 `background: var(--c-bg-hover)`
- **折叠箭头**: 10x10 SVG chevron, `stroke: var(--c-text-5)`, 展开时 `rotate(90deg)`, `transition: transform var(--duration-fast) ease`
- **标题文字**: `fontSize: var(--fs-meta)`, `fontWeight: 600`, `color` 按分区不同(见下方)
- **计数 pill**: `fontSize: var(--fs-badge)`, `color: var(--c-text-4)`, `background: var(--c-bg-3)`, `borderRadius: var(--r-pill)`, `padding: 1px 6px`, `fontFamily: var(--font-mono)`
- **间距**: header 内部 `gap: 6`

### 分区颜色映射

| 分区 | header 标题色 | header 左边条 | 文件行 FileStatusBadge |
|------|-------------|-------------|---------------------|
| 已暂存 (staged) | `var(--c-success)` | 2px solid `var(--c-success)`, opacity 0.5 | 现有样式不变 |
| 未暂存 (unstaged) | `var(--c-text-4)` | 无 | 现有样式不变 |
| 未追踪 (untracked) | `var(--c-text-5)` | 无 | status "?" 使用 `{ bg: "var(--c-bg-3)", text: "var(--c-text-5)" }` |

### Staged 分区的视觉区分

Staged 分区通过 header 左侧的 2px 竖条标记 (类似 Toast 的 accent bar):

```
  ┃  ▾  已暂存 · 3
  ┃    ┌────────────────┐
  ┃    │ M  file.tsx ... │
  ┃    └────────────────┘
```

实现: header 和文件行容器外包一层 div, 左侧 `borderLeft: 2px solid var(--c-success)`, `borderRadius: 0`, `paddingLeft: 0`。仅 staged 分区有此边条, unstaged/untracked 没有。

## 文件行样式

文件行样式保持完全不变, 复用现有 `diff-file-row`:
- 外壳: `background: var(--c-bg-white)`, `border: 1px solid var(--c-border-2)`, `borderRadius: var(--r-btn)`, `marginBottom: 3`
- FileStatusBadge: 保持原样
- 编辑器跳转按钮: `diff-file-open hover-bg` class, hover 时 opacity 1
- 展开 chevron: 保持原样
- `+N -N` 行数统计: 保持原样

"both" 文件在两个分区各出现一次, path 相同, 展开的 diff 内容由后端区分 staged/unstaged 各自的 patch。

## 折叠行为

- 默认全部展开
- 折叠状态存在组件本地 state, 不持久化
- 当某分区文件数为 0 时, 不渲染该分区(包括 header)
- 折叠时隐藏文件行, header 保持可见
- 折叠动画: 无(直接 display none/block, 和 Sidebar 保持一致)

## 分区顺序

固定顺序: **已暂存 → 未暂存 → 未追踪**

当只有一个分区有文件时, 仍显示分区 header(提供信息), 但不可折叠(单分区没有折叠意义)。

## 空状态

- 全部分区无文件(工作区干净): 保持现有 `PanelEmptyState` checkmark
- git 状态未知/非 git: 保持现有空状态

## 组件结构

```
DiffPanel
  └── ScrollArea
      ├── StagedSection (if staged.length > 0)
      │   ├── SectionHeader "已暂存" count={staged.length}
      │   └── FileRow[] (existing diff-file-row)
      ├── UnstagedSection (if unstaged.length > 0)
      │   ├── SectionHeader "未暂存" count={unstaged.length}
      │   └── FileRow[]
      └── UntrackedSection (if untracked.length > 0)
          ├── SectionHeader "未追踪" count={untracked.length}
          └── FileRow[]
```

SectionHeader 是纯展示组件, 不需要 ContextMenu。

## 关键样式数值

```css
/* SectionHeader */
padding: 4px 8px;
gap: 6px;
font-size: var(--fs-meta);      /* 11px */
font-weight: 600;

/* Staged 左边条 */
border-left: 2px solid var(--c-success);
opacity: 0.5 on the border;     /* 通过颜色 alpha 实现 */

/* 分区间距 */
margin-bottom: 6px;             /* 分区之间 */
padding: 6px;                   /* 复用现有文件列表 padding */

/* 计数 pill */
font-size: var(--fs-badge);     /* 9px */
padding: 1px 6px;
border-radius: var(--r-pill);
background: var(--c-bg-3);
color: var(--c-text-4);
```

## 暗色模式

所有颜色使用 CSS 变量, 暗色模式自动适配:
- `--c-success` 浅色 `#2f9e7a` / 暗色 `#4ade80`
- `--c-text-4` 浅色 `#71717a` / 暗色 `#71717a`
- `--c-text-5` 浅色 `#a1a1aa` / 暗色 `#52525b`
- 背景/边框全部跟随 tokens 自动切换

## 不做

- Stage/Unstage 操作按钮(本期只读)
- Hunk-level staging
- Commit UI
- 分区折叠状态持久化
