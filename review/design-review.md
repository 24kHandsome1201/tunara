# Conduit 界面设计审查意见

审查范围: 全部 UI 组件源码 + 设计 token 体系
审查日期: 2026-06-21

---

## 总体评价

Token 体系完整度高, Terracotta 强调色有辨识度, 文字层级分 7 级足够细腻, 深浅色适配覆盖全面. 整体方向是"轻量克制的开发者工具", 和 Linear / Warp 同赛道, 审美基线不低.

以下问题按严重程度分三档:
- **P0** 功能或可用性缺陷, 应优先修复
- **P1** 设计不一致或粗糙, 影响品质感
- **P2** 细节打磨, 非必要但能提升整体精致度

---

## 1. 标题栏

### 1.1 Tab 关闭按钮 hit target 过小 [P1]

`TabButton` 关闭按钮 16x16, 圆角 50%. 实际可点击区域约 12px 直径, 容易误触到 tab 本身或点不到. Fitts 定律下建议至少 20x20.

> 位置: `Titlebar.tsx:89`

### 1.2 侧栏折叠后 tabs 和 toggle 按钮之间缺间距 [P1]

`sidebarVisible = false` 时, tabs 容器紧贴侧栏 toggle 按钮, 没有间距. 视觉上 toggle 按钮和第一个 tab 挤在一起.

> 位置: `Titlebar.tsx:219-265`
> 建议: tabs 容器加 `paddingLeft: 8`

### 1.3 右侧按钮组 gap 和 tab 区域不协调 [P2]

右侧按钮 `gap: 10`, tab 区域 `gap: 6`. 设置和面板按钮之间视觉间距明显偏大. 建议统一为 `gap: 4` 或 `gap: 6`.

> 位置: `Titlebar.tsx:274`

### 1.4 少量 tab 时 pill 形态视觉重心不稳 [P2]

pill 形 tab + `padding: 0 10px`, 当标签文字短(如 "zsh")时按钮矮而宽, 和侧栏展开时标题栏的极简状态对比突兀.

---

## 2. 侧栏

### 2.1 快捷键标注样式不统一 [P1]

侧栏新建按钮的 `⌘T` 用纯文本 `fontSize: var(--fs-badge)` 显示, 而 CommandPalette 的快捷键用 `background + padding + borderRadius` 的 badge 样式. 应全局统一为 badge 样式.

> 位置: `Sidebar.tsx:320-329` vs `CommandPalette.tsx:419-430`

### 2.2 新建按钮和搜索框的 padding 不对称 [P1]

新建按钮区 `padding: 10px 12px 6px`, 搜索框区 `padding: 6px 12px`. 上方 10px 偏宽, 整体间距不均匀. 建议统一为 `8px 12px`.

> 位置: `Sidebar.tsx:295, 335`

### 2.3 目录分组 header 和 SessionCard 文字不对齐 [P0]

`DirGroupHeader` padding `6px 14px`, SessionCard padding `7px 10px 7px 12px`, 容器 padding `0 8px`. 多层嵌套导致 header 文字和 card 标题不在同一对齐轴上, 列表看起来参差不齐.

> 位置: `Sidebar.tsx:85, 242, 374`
> 建议: 建立统一的左边距基准, 所有行内容的文字起始位置对齐

### 2.4 底部"会话"统计栏信息密度过低 [P2]

只显示 "会话" + 数字 badge, 高度虽不大但占据了固定的底部空间, 信息价值不高. 可考虑合并到搜索框旁或移除.

> 位置: `Sidebar.tsx:467-492`

### 2.5 隐藏滚动条后缺少滚动提示 [P1]

`no-scrollbar` 隐藏了滚动条, 会话多时用户无法感知列表可滚动. 缺少顶部/底部渐隐遮罩或滚动阴影提示.

> 位置: `Sidebar.tsx:375`

---

## 3. 会话卡片

### 3.1 左侧活跃指示条动画过度设计 [P2]

活跃状态的左边条同时 transition 了 `height + min-height + opacity` 三个属性, 但实际效果用户几乎感知不到. 简化为纯 opacity 切换即可.

> 位置: `SessionCard.tsx:256-268`

### 3.2 unread 圆点和关闭按钮位置冲突 [P0]

`unread` 圆点 `right: 8, top: 50%`, 关闭按钮 `top: 6, right: 6`. hover 时关闭按钮出现, 会遮住 unread 圆点. 两个元素视觉重叠.

> 位置: `SessionCard.tsx:274-276, 295-296`
> 建议: unread 圆点改到 icon 上(已有 StatusDot)或关闭按钮位置调整

### 3.3 DiffStat badge 和路径信息缺少最小间距 [P2]

DiffStat 用 `marginLeft: auto` 推到右侧, 窄侧栏时路径被截断后 diff badge 紧贴截断文字, 缺少 `gap` 或 `min-gap` 保护.

> 位置: `SessionCard.tsx:147`

---

## 4. 终端区域

### 4.1 终端容器 padding 过小 [P1]

终端 padding 仅 `var(--sp-1)` = 4px, 文字几乎贴边. 大部分终端应用(iTerm2, Warp, Hyper)至少用 8px. 4px 让内容透不过气.

> 位置: `TerminalView.tsx:698`
> 建议: 改为 `var(--sp-2)` (8px)

### 4.2 状态栏信息溢出风险 [P0]

底部状态栏路径占 `flex: 1 1 auto`, 后续分支/agent/ahead-behind 全部 `flexShrink: 0`. 当路径长 + agent 激活 + ahead/behind 都有值时, 路径会被压缩到几乎不可见, 但其他元素不收缩.

> 位置: `MainArea.tsx:148-261`
> 建议: 给后部信息一个合理的 overflow 策略, 或在窄宽度下隐藏部分次要信息

### 4.3 分栏按钮图标难以区分 [P1]

水平分栏和垂直分栏的图标在 13px 尺寸下几乎无法分辨方向. 只有 `title` tooltip 能区分.

> 位置: `MainArea.tsx:217-259`
> 建议: 图标内部加细节区分度, 或直接用文字标签

### 4.4 分屏活跃面板 outline 视觉噪声大 [P1]

`outline: 2px solid var(--c-accent)` + `outlineOffset: -2px`. Terracotta 橘色 2px 轮廓在白底上非常抢眼, 和应用其他地方克制的视觉风格不匹配.

> 位置: `MainArea.tsx:99`
> 建议: 降到 1px, 或改用底部边框条标记

---

## 5. Agent 状态栏

### 5.1 浮层遮挡终端顶部内容 [P0]

`top: 4, height: 32`, 遮挡终端顶部约 36px 内容. agent 运行中用户看不到终端最顶部输出, 且没有给终端增加对应的 paddingTop.

> 位置: `AgentStatusBar.tsx:49-52`
> 建议: agent 激活时给终端容器增加 paddingTop, 或将状态栏放在终端外部

### 5.2 消失动画拖沓 [P1]

agent 完成后延迟 3 秒 + 0.5s fade, 总共 3.5 秒才消失. 完成状态的浮层停留过久, 显得拖沓.

> 位置: `AgentStatusBar.tsx:31, 64`
> 建议: 延迟降到 1.5s, fade 降到 0.3s

---

## 6. 设置面板

### 6.1 主题缩略图细节过碎 [P2]

ThemeCard 内 traffic light 4px, 侧边栏线条 2.5px, 终端线条 2px. 在 56px 高缩略图里几乎看不清, 只是视觉噪声. 简化为纯色块对比即可.

> 位置: `Settings.tsx:28-46`

### 6.2 强调色选中态"膨胀" [P2]

AccentRing 选中态 `border: 2px` + `boxShadow: 0 0 0 1px`, 双重描边导致选中态比未选中明显大一圈. 不够克制.

> 位置: `Settings.tsx:57`

### 6.3 字号 +/- 按钮缺少 hover 态 [P1]

字号调节按钮没有 `hover-bg` class, hover 时无视觉反馈. 和应用其他所有交互按钮不一致.

> 位置: `Settings.tsx:204-207`

### 6.4 终端配色卡片固定 100px 宽度 [P1]

7 个卡片固定 `width: 100`, flexWrap 换行后下排数量不可控, 间距不均匀. 窄窗口下可能溢出.

> 位置: `Settings.tsx:226`
> 建议: 用 grid 布局或计算列数

### 6.5 CLI tab 内容空洞 [P2]

CLI tab 只列出已安装 agent 的只读路径信息, 无可操作项. 和"外观" tab 的丰富控件对比显得空洞.

> 位置: `Settings.tsx:266-294`

### 6.6 "恢复默认"在 CLI tab 下误导 [P1]

"恢复默认"按钮始终显示, 但在 CLI tab 下点击会重置外观设置而用户此时看不到变化, 容易误操作.

> 位置: `Settings.tsx:299-303`
> 建议: CLI tab 下隐藏或禁用此按钮

---

## 7. 命令面板

### 7.1 选中项的左侧竖条多余 [P2]

复用了 SessionCard 的 3px 竖条设计, 但命令面板中键盘焦点用背景色区分已足够. 竖条在这里显得多余, 且增加了视觉复杂度.

> 位置: `CommandPalette.tsx:377-387`

### 7.2 section header 和列表项左边距不对齐 [P1]

section 标题 `padding: 6px 16px`, 列表项 `padding: 7px 14px` + `margin: 0 6px`. 左边距分别为 16px 和 20px, 不对齐.

> 位置: `CommandPalette.tsx:352, 369-373`

---

## 8. 审查面板

### 8.1 DiffPanel 文件行边框过于碎片化 [P1]

每个文件行独立 `border: 1px solid` + `borderRadius`, 相邻行之间 `marginBottom: 3`. 两层边框 + 间距 = 5px 视觉分割, 列表看起来像松散的卡片堆而非紧凑的文件列表.

> 位置: `DiffPanel.tsx:206`
> 建议: 改为无边框列表 + 分隔线, 或取消单行边框改用容器边框

### 8.2 "刷新"按钮重复出现 [P1]

embedded 模式下, summary 栏有刷新, 底部状态栏有刷新, standalone header 也有刷新. 同一功能三个入口, 增加认知负担.

> 位置: `DiffPanel.tsx:338, 387, 284`
> 建议: 保留一个主入口, 其余移除

### 8.3 文件状态 badge 颜色区分度不够 [P1]

M(修改), R(重命名), ?(未追踪) 三种状态都用相同的灰色处理, 视觉上无法区分, 失去了 badge 的意义.

> 位置: `DiffPanel.tsx:62-67`
> 建议: R 用蓝色系, ? 用虚线边框或不同灰度

---

## 9. 文件浏览器

### 9.1 面包屑路径分隔符不直观 [P2]

`pathDisplay` 用 `· /` 组合分隔路径段, 如 `· / src / ui`. 中点 + 斜杠不是常见路径表示法, 不够自然.

> 位置: `FileExplorer.tsx:58`
> 建议: 用 `/` 或 `›` 箭头

### 9.2 文件大小列不对齐 [P2]

不同长度的 size 文字(`1.2 KB` vs `12 B` vs `134 KB`)没有 `minWidth`, 右侧参差不齐.

> 位置: `FileExplorer.tsx:379`
> 建议: 加 `minWidth: 48, textAlign: "right"`

### 9.3 搜索结果路径截断严重 [P2]

搜索结果显示完整相对路径, 同样 30px 行高, 比目录浏览的纯文件名更容易被截断. 可考虑对路径做智能缩略(只显示 `…/最后两段`).

---

## 10. 右键菜单

### 10.1 没有动画 [P1]

菜单直接弹出, 无 fadeIn 或 scale 过渡. 应用其他所有弹出层(设置/命令面板/toast)都有动画, 右键菜单没有, 显得突然.

> 位置: `ContextMenu.tsx:52-67`

### 10.2 菜单项没有图标 [P2]

所有 item 纯文字. 相同操作("在编辑器中打开")在 CommandPalette 有图标, 右键菜单没有. 体验不一致.

> 位置: `ContextMenu.tsx:82-104`

### 10.3 阴影规格游离在 token 体系外 [P1]

用了独立的 `boxShadow: "0 8px 30px rgba(0,0,0,0.12)"`, 不是 token 体系中的 `--shadow-overlay` 或 `--shadow-card`. 应引入 `--shadow-menu` token 或复用已有.

> 位置: `ContextMenu.tsx:66`

---

## 11. Toast 通知

### 11.1 宽度过窄 [P2]

固定 `width: 260`, agent 名称 + 文件路径较长时内容截断严重. 建议 `minWidth: 260, maxWidth: 340` 自适应.

> 位置: `Toast.tsx:62`

### 11.2 左侧 accent 竖条挤压内容空间 [P2]

260px 宽度中, 3px 竖条 + 10px gap + 图标 + 文字 + 关闭按钮, 有效文字区域约 180px, 偏紧.

> 位置: `Toast.tsx:81`

---

## 12. 全局层面

### 12.1 Linux 字体回退链不够保险 [P1]

`--font-ui: -apple-system, system-ui, sans-serif`. Linux 上 `-apple-system` 无效, `system-ui` 在部分 WebKitGTK 版本可能映射到不理想字体. 建议加 `"Segoe UI", Roboto`.

> 位置: `tokens.css:90`

### 12.2 Agent 圆形图标硬编码色值, dark mode 不适配 [P0]

`AGENT_CIRCLE_STYLES` (badge.tsx) 用硬编码 hex 色值, 而 `tokens.css` 定义了完整 `--c-agent-*` CSS 变量且有 dark mode 适配. SessionCard 的 icon 用硬编码色值, AgentBadge 用变量. dark mode 下 SessionCard 的 agent 圆形图标色值不变, 视觉不协调.

> 位置: `badge.tsx:3-15` vs `tokens.css:44-76, 186-218`
> 建议: `AGENT_CIRCLE_STYLES` 统一使用 CSS 变量

### 12.3 11px 辅助字号在低 DPI 屏幕可读性差 [P2]

`--fs-meta: 11px` 用于路径/分支/diff 统计等大量信息. 在 1x DPI 屏幕上会发糊. `--fs-meta-sm: 10.5px` 更是接近可读性极限.

> 位置: `tokens.css:98-99`

### 12.4 内联样式大量重复 [P2]

几乎所有组件用内联 `style={{}}`, 导致同样的 icon 按钮样式(`width/height/borderRadius/border/background/cursor/display/alignItems/justifyContent`)在十几个文件中重复出现. 不影响功能, 但增加维护成本.

---

## 优先修复建议

按影响面和修复成本排序:

| 优先级 | 问题 | 影响 |
|--------|------|------|
| P0 | 2.3 侧栏文字不对齐 | 每次打开都能看到 |
| P0 | 3.2 unread 圆点被关闭按钮遮挡 | 功能性遮挡 |
| P0 | 4.2 状态栏信息溢出 | 窄窗口下信息丢失 |
| P0 | 5.1 Agent 浮层遮挡终端内容 | 影响终端可用性 |
| P0 | 12.2 Agent 图标 dark mode 不适配 | dark mode 视觉错误 |
| P1 | 4.1 终端 padding 过小 | 影响阅读舒适度 |
| P1 | 6.3 字号按钮缺 hover 态 | 交互断裂 |
| P1 | 8.1 DiffPanel 边框碎片化 | 影响信息密度 |
| P1 | 10.1 右键菜单无动画 | 体验不连贯 |
| P1 | 10.3 阴影规格不统一 | token 体系完整性 |
