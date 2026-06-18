# Handoff: Conduit — AI 原生终端（Tauri + xterm.js）

## Overview
Conduit 是一个 macOS 风格的「AI 原生终端」：侧边栏不是文件树，而是**按工作目录分组的会话列表**，每个会话挂着一个 AI agent（Claude Code / Codex / Cursor）。主区是真实终端流，AI 的回复**内联**渲染在终端里；右侧是当前会话的**审查 / diff 面板**，底部可直接提交并推送。

目标技术栈：**Tauri（Rust 后端）+ Web 前端 + xterm.js**。真实终端用 xterm.js + 一个 pty 后端（Tauri 侧用 `portable-pty` / `tauri-plugin-shell` 起 shell，前后端用事件/IPC 流式传输）。本交接包里的 HTML 只描述**外观与交互**，不含终端后端。

## About the Design Files
本包内的 `.dc.html` 文件是用 HTML 制作的**设计参考原型**——展示预期的外观和交互，**不是直接拷贝进产品的生产代码**。任务是：用目标代码库现有的环境（这里建议 Tauri webview 内的前端框架，如 React/Svelte/Vanilla TS）**复刻这些设计**，并把"终端"部分接到 xterm.js + Tauri pty 后端。视觉壳层（标题栏、侧边栏、标签页、审查面板、弹层）按本文档像素级复刻；终端内容区改为真实 xterm.js 实例。

## Fidelity
**高保真 (hifi)**。颜色、字体、间距、圆角、交互均为最终值，请按下方 Design Tokens 与各区块说明精确复刻。`Conduit.dc.html` 是**可交互**原型（会话切换、弹层、折叠、面板开关都已实现），可直接对照其行为。

---

## 布局总览
全窗口铺满，竖向 flex：
1. **标题栏** `height:48px`，`#fbfbfc`，下边框 `1px #ededf0`。
2. **主体** `flex:1`，横向 flex，三栏：**侧边栏(272px) | 终端(flex:1) | 审查面板(300px)**。侧边栏和审查面板均可隐藏。

字体：界面用 `-apple-system, system-ui`；所有终端/代码/路径/分支/快捷键用 `'JetBrains Mono'`（已通过 Google Fonts 引入，权重 400/500/600/700）。

---

## 标题栏（从左到右）
- **红绿灯**：三个 12px 圆点 `#ff5f57 / #febc2e / #28c840`，间距 8px。
- **折叠侧边栏按钮**：28×24，圆角 7，无边框无填充，hover `#f0eff2`。图标为 panel-left SVG（描边 `#71717a`，左栏小块填 `#c2683c` 透明度 0.3）。点击切换侧边栏显隐。
- **标签页区**：每个标签 `padding:7px 13px 8px`，圆角 `8px 8px 0 0`。激活标签：白底 `#fff` + `1px #e6e6e9` 边 + **顶部 2px `#c2683c`**。标签内容 `<dir> ⎇ <branch>`，dir 12px `#27272a`，branch 11px `#a1a1aa`。非激活标签文字 `#71717a`/`#c4c4cc`。末尾 `+` 按钮(打开"新建 Agent")。点击标签切换会话。**始终恰好一个标签激活**（点击不在固定标签中的历史会话时，动态生成一个高亮标签）。
- **右侧簇**（`margin-left:auto`，gap 10px），三个等形状按钮（28×24 / 圆角7 / hover `#f0eff2`）：
  - **审查视图开关** `+−`：JetBrains Mono 11px 700，`+` 绿 `#2f9e7a`、`−` 红 `#e0556b`。切换右侧审查面板显隐。
  - **通知铃铛**：bell SVG `#71717a`，右上红角标 `#e0556b` 白字显未读数（`2`）。点击开关通知中心。

> 注意：主题切换**不在**标题栏（早期评审移除），改在「设置」里。

## 侧边栏（272px，`#f7f7f8`，右边框 `1px #ededf0`）
1. **顶部分段按钮**（白底，`1px #e6e6e9`，圆角9，整体 overflow:hidden）：
   - 左段「+ 新建终端」`#3f3f46` 600，右侧 `⌘T` 灰提示——**即时新建终端，无需表单**。
   - 1px 分隔 `#ededf0`。
   - 右段「✦ Agent」`#c2683c` 600——**打开"新建 Agent"弹层**（需选目录+agent）。
2. **搜索框**：`#efeff1` 圆角8，放大镜 SVG + "搜索会话" `#a1a1aa`。
3. **会话列表**（`overflow-y:auto`，按目录分组）：
   - **目录头**：文件夹 SVG(描边 `#b4b4bc`) + 路径(JetBrains Mono 11.5px 600 `#52525b`) + 计数胶囊(`#efeff1`)。分组：`~/orbit`(3) / `~/web`(1) / `~/infra`(1)。
   - **会话卡**（点击切换）：`padding:10px 11px`，圆角9。激活态：白底 + `1px #e6e6e9` + **左边 3px `#c2683c`** + 轻阴影（用绝对定位层实现，避免 hover 抖动）。
     - 行1：22×22 圆角6 的 **agent 角标**（CC=琥珀 `bg#fbeadf/bd#f1d6c6/字#c2683c`；CX=绿 `#dff2ea/#c6e7d9/#2f9e7a`；CU=蓝 `#e4e9fb/#cfd9f5/#4f6ef0`）+ 标题(13px 600，省略号) + 可选未读绿点。
     - 行2（meta，全部 `flex:none; white-space:nowrap` 防换行）：`⎇ <branch>`(10.5px `#a1a1aa`) + 状态 + 右对齐时长。
       - 状态：**运行中**=`#c2683c` + 呼吸点(脉冲动画)；**刚完成**=`#2f9e7a` 600 + 勾;**exit 0**=`#9aa0a6` + 静止灰点。
     - 运行中卡额外一条 3px 进度条（轨 `#f0eae6`，填 `#c2683c`，宽度示意进度）。
4. **底部**：齿轮 SVG + "设置"(打开设置弹层) + 右侧 "5 个会话"。

## 终端（中栏，`flex:1`，`#fff`）
- 内容区 `padding:20px 24px`，13px，行高 1.85，JetBrains Mono。
- **shell 配色（终端专属，刻意区别于 UI 灰阶）**：路径蓝 `#2563eb`、提示符 `❯` 绿 `#16a34a`、错误/FAIL 红 `#dc2626`、PASS 绿、次要 `#71717a`。
- **内联 AI 回复块**：左边 2px `#c2683c`，块内：18px agent 角标 + agent 名 `#27272a` 600 + `· <会话标题>` `#c2683c`；正文用界面字体 13px `#3f3f46`；行动按钮「应用补丁」(墨黑 `#27272a` 白字 圆角7) +「查看 diff」(描边)。
- 末行：`❯` + 输入 + 闪烁光标（8×16 `#27272a`，`blink` 动画）。
- **底部状态栏** `height:30px` `#fbfbfc`：路径(蓝) · `⎇ branch` · `node 20.11` · `UTF-8` · 时间，11.5px `#71717a`。

## 审查 / diff 面板（右栏，300px，`#f7f7f8`，左边框）—— **跟随当前会话**
- **头** `height:40px`：「改动」12.5px 600 + `⎇ <branch>`(mono) + 右对齐摘要(如 `3 文件 · +26 −6`，mono `#b4b4bc`)。
- **体**（按会话状态三选一）：
  - **有改动**：文件卡列表。首个可展开显示 mini diff（hunk 头 `#b4b4bc`；删除行底 `#fcebec` 字 `#c0414e`；新增行底 `#e8f6ef` 字 `#1f8a5b`）；其余折叠（M/A 标记 + 路径 + `+x −y` + `▸`）。
  - **干净**：居中空状态——42px 圆角块 `#eef1ef` 内放勾 SVG `#9aa0a6` + "工作区干净" 13px 600 `#52525b` + "git status · 无未提交改动" mono `#a1a1aa`。
- **底（仅有改动时显示）**：提交信息输入（白底圆角8，带闪烁光标）+ 行：「提交」(浅灰 `#efeff1`)、「**提交并推送**」(墨黑 `#27272a` 白字，上箭头图标)；下方 `origin/<branch> · 领先 0 · 落后 0`。

## 弹层

### 新建 Agent（点 ✦ Agent 或 标签 `+`）
居中 sheet 520px，圆角14，重阴影，背景半透明遮罩 `rgba(20,20,28,0.34)` + blur，`sheetIn` 入场动画。
- 头：「新建 Agent」16px 700 + 副标题 "选择工作目录与 agent，在该会话中开始协作。"
- **工作目录**：可选行，文件夹图标(琥珀) + `~/orbit`(mono) + "最近" + 下拉箭头。
- **Agent**：三张可选卡（CC/CX/CU），各含角标 + 名称 + 一句说明；选中态=`1px #f1d6c6` 边 + `#fbf6f2` 底 + 琥珀圆勾；未选=空心圆环 `#d4d4d8`。
- 底：`⎇ main · zsh`(mono) + 「取消」(描边) + 「创建 Agent ⌘⏎」(墨黑)。遮罩/取消/创建均关闭。

### 设置（点侧栏底部"设置"）
居中 sheet 600px。头：「设置」+ 子标签胶囊(外观[选中]/字体/Agents/快捷键) + 右上 ✕。
- **主题**：三张预览卡（浅色[选中]/深色/跟随系统），各为迷你窗口缩略图 + 单选。选中=卡内 2px `#c2683c` 边框 + 实心琥珀单选点。（深色主题本期**不实装**，仅切换选中态。）
- **强调色**：5 个色环，琥珀选中(双环高亮) + `#C2683C · Terracotta` 标签(mono)。
- **终端**：「光标样式」分段(竖条[选中]/方块/下划线)。
- 底：「更改即时生效」+「完成」(墨黑)。

---

## Interactions & Behavior
- **会话切换**：点侧栏卡 / 标签 → 更新激活高亮、终端流、状态栏 path/branch、审查面板。
- **新建终端**：即时（无弹层）；**新建 Agent**：弹层选目录+agent。
- **折叠侧边栏**：标题栏左按钮；**审查面板开关**：标题栏 `+−` 或终端内「查看 diff」。
- **通知中心**：铃铛开关，失败项(红，持久) + 完成项(绿)；角标计数与未读一致。
- **动画**：`blink` 1.1s 光标；`pulseDot` 1.3s 运行中呼吸；`toastIn .3s` 通知；`sheetIn .24s` / `fadeIn .2s` 弹层。
- 所有图标按钮 hover `#f0eff2`。

## State Management（前端）
- `activeSession`：当前会话 id。
- `sidebarVisible` / `panelVisible`：布尔，控制两侧栏显隐。
- `overlay`：`null | 'agent' | 'settings'`。
- `notifOpen`：布尔。
- `agentPick`：`'CC' | 'CX' | 'CU'`（新建 Agent 选中）。
- `theme`：`'light' | 'dark' | 'system'`（设置；dark 未实装）。
- 每个会话数据：`{ id, title, dir, branch, agent, status('running'|'fresh'|'done'), cmd, 终端流, 改动文件列表 + 摘要 + commit 建议 }`。

### 接真实终端（xterm.js + Tauri）
- 每个会话 = 一个 xterm.js 实例 + 一个 pty（Tauri 后端 `portable-pty` 起 shell）。前端 `term.onData` → IPC 写 pty；pty 输出 → 事件流 → `term.write`。
- 切换会话 = 切换显示对应 xterm 实例（保活后台进程）。
- AI 内联块、状态栏 git 信息、审查面板 diff 由各 agent/Git 集成提供；本设计只规定其**呈现**。

## Design Tokens
**颜色**
- 强调(Terracotta)：`#c2683c`；浅底 `#fbeadf`/`#fbf6f2`，边 `#f1d6c6`
- 文字：`#27272a`(主) / `#3f3f46` / `#52525b` / `#71717a` / `#a1a1aa` / `#b4b4bc` / `#c4c4cc`
- 面/底：`#ffffff` / `#fbfbfc` / `#f7f7f8` / `#efeff1` / `#f0eff2`(hover)
- 线：`#ededf0` / `#e6e6e9` / `#f1f1f3`
- 语义：成功 `#2f9e7a`(底 `#dff2ea/#e8f6ef`) / 失败 `#e0556b`(底 `#fdf4f5/#fbe1e5`) / 警告 `#e2c08d`
- agent：CC `#c2683c` · CX `#2f9e7a` · CU `#4f6ef0`
- shell：路径 `#2563eb` · 提示符/PASS `#16a34a` · 错误 `#dc2626`
- diff：删 底`#fcebec`字`#c0414e` · 增 底`#e8f6ef`字`#1f8a5b`

**字体**：UI `-apple-system, system-ui`；等宽 `'JetBrains Mono'`(400/500/600/700)。尺寸：标题16 / 区块13.5 / 正文13 / 次要12–12.5 / meta 10.5–11.5 / 角标9。
**圆角**：按钮/输入 7–8；卡片/标签 9；弹层 14；角标 6；胶囊 100px。
**间距**：卡内 padding 10–11；区栏 padding 14；gap 主要 8–10。
**阴影**：卡 `0 1px 2px rgba(0,0,0,0.03)`；弹层 `0 30px 80px rgba(20,20,30,0.4)`；通知 `0 16px 40px rgba(20,20,30,0.18)`。

## Assets
无位图。所有图标为内联 SVG（文件夹、搜索、铃铛、齿轮、勾、叉、箭头、panel 等），可直接复用或换成 lucide 等等价图标。字体走 Google Fonts（JetBrains Mono）。

## Files
- `Conduit.dc.html` — **可交互高保真原型（主参考）**。三栏布局 + 全部弹层与交互。
- `Terminal Concepts.dc.html` — 概念看板（参考）：5 种风格探索(Paper/Graphite/Aurora/Mist/Carbon) + 设置页 + 新建 Agent 页。**Paper(浅色) 即最终方向**，其余仅作风格备选参考，不必实现。
