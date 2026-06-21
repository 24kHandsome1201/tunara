# 设计文档: 右键菜单系统

> 当前口径: 右键菜单是低噪声的桌面操作入口, 不承担 Agent 启动器职责。

## 1. 背景

Conduit 的主线是带智能侧栏的真实终端。用户在真实终端里运行 `claude`, `codex` 等 CLI, Conduit 负责识别、标记运行态和展示 Git review 上下文。右键菜单用于承载和当前位置强相关的轻量操作, 例如新建终端、在编辑器中打开、复制路径、关闭会话。

不再提供 "启动所有 Agent"。这个入口会一次性创建多个未预检的终端 session, 容易产生 `command not found`, 也会把产品拉向 agent 管理平台。

## 2. 设计目标

- 通用 `ContextMenu` 组件, Sidebar 和 FileExplorer 复用。
- 操作只围绕当前目录、当前会话或当前文件。
- 视觉上继承 overlay/token 体系, 阴影走 `--shadow-menu`。
- 支持 Escape, ArrowUp, ArrowDown, Home, End, Enter 和 Space。
- 不覆盖 hover 快捷按钮, 只作为发现和补充入口。

## 3. 菜单规格

### Sidebar 目录组

| 条目 | action | danger |
|---|---|---|
| 在此目录新建终端 | `newTerminalInDir(dir)` | 否 |
| 在编辑器中打开 | `openInEditor(externalEditor, dir)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(dir)` | 否 |
| 分割线 | | |
| 关闭全部会话 | `closeSessionsInDir(dir)` | 是 |

### Sidebar 会话

| 条目 | action | danger |
|---|---|---|
| 重命名 | `startRenaming(session.id)` | 否 |
| 在编辑器中打开 | `openInEditor(externalEditor, session.dir)` | 否 |
| 复制目录路径 | `navigator.clipboard.writeText(session.dir)` | 否 |
| 分割线 | | |
| 关闭会话 | `closeSession(session.id)` | 是 |

### FileExplorer 目录

| 条目 | action | danger |
|---|---|---|
| 在此目录新建终端 | `newTerminalInDir(fullPath)` | 否 |
| 在编辑器中打开 | `openInEditor(externalEditor, fullPath)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(fullPath)` | 否 |

### FileExplorer 文件

| 条目 | action | danger |
|---|---|---|
| 在编辑器中打开 | `openInEditor(externalEditor, fullPath)` | 否 |
| 复制路径 | `navigator.clipboard.writeText(fullPath)` | 否 |

## 4. 组件行为

- fixed 定位, 以鼠标坐标为锚点。
- 首次渲染后测量尺寸, 超出右边界则向左展开, 超出下边界则向上展开。
- 点击外部、Escape、窗口 resize 或执行条目后关闭。
- 容器使用 `role="menu"`, 条目使用 `role="menuitem"`, 分割线使用 `role="separator"`。
- 键盘操作在可用条目之间循环, disabled 条目不参与焦点顺序。

## 5. 不做的事

- 不做批量启动 Agent。
- 不做 agent 列表配置。
- 不做 agent CLI 安装预检测入口。
- 不做嵌套子菜单。
- 不做文件写操作, 例如新建、重命名、删除或粘贴文件。

## 6. 验收清单

- [ ] 右键 Sidebar 目录组, 菜单出现并包含 4 个有效操作。
- [ ] 右键 Sidebar 会话, 菜单出现并包含重命名和关闭。
- [ ] 右键 FileExplorer 目录或文件, 菜单项符合当前对象类型。
- [ ] 菜单靠近窗口右边界或下边界时不会溢出。
- [ ] Escape 关闭菜单。
- [ ] ArrowUp/ArrowDown/Home/End 可以移动选中项。
- [ ] Enter/Space 可以执行当前选中项。
- [ ] 暗色模式下菜单背景、阴影、文字和 hover 状态使用 token。
