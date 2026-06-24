# Otty vs Conduit 侧栏设计对比

基于 Otty 官网截图与 Conduit 源码的逐项视觉分析。

---

## Otty 侧栏特征

| 特征 | 细节 |
|------|------|
| 宽度 | 极窄,单行纯文本,无副标题 |
| 条目风格 | 纯文本列表,不用圆形 icon,更像文件树 |
| 分组 | 树形缩进表达层级,不用分割线或独立 header |
| 状态 | 文字旁小彩色圆点,位置在文字左/右侧 |
| 底色 | 接近 #fafafa,与主区域几乎同色,分隔靠一条极细 border |
| Hover | 非常克制,不出现大面积色块 |
| 整体气质 | 纯文本编辑器风格,极度轻量 |

## Conduit 侧栏特征

| 特征 | 细节 |
|------|------|
| 宽度 | 中等,双行信息结构(标题 + 目录/分支/diff) |
| 条目风格 | 24px 圆形 icon(Agent 品牌色圆,Shell 灰底 `>_`) |
| 分组 | DirGroupHeader: 文件夹图标 + 目录名 + 计数 badge,可折叠 |
| 状态 | 三层: StatusDot(圆点) + StatusMark(对勾/圆点/叉) + BusyProgress(底部进度条) |
| Active 态 | 左侧 2px terracotta 竖条 + 浅橙底色 |
| Hover | hover-bg 色块 + hover-close 显现关闭按钮 |
| 整体气质 | 信息密度中等,有色彩但不重,Agent 辨识度高 |

---

## 逐维度对比

| 维度 | Otty | Conduit | 判断 |
|------|------|---------|------|
| 信息密度 | 单行纯文本,极高密度 | 双行(标题+元数据),中等密度 | **Conduit 更好**。终端管理器需要目录和分支,纯文件名不够 |
| 图标系统 | 无 icon,纯文本 | 24px 圆形 Agent 头像 + Shell 图标 | **Conduit 更好**。多 Agent 类型需要视觉区分 |
| 分组方式 | 树形缩进 | DirGroupHeader + 折叠 | 各有千秋。Otty 更紧凑,Conduit 更清晰 |
| Active 态 | 浅色背景 | 左竖条 + 浅橙底 | **Conduit 更有辨识度** |
| 状态指示 | 小圆点 | 三层(Dot + Mark + Progress) | Conduit 更丰富,但也更复杂 |
| 视觉克制度 | 极度克制,接近纯文本 | 中等,有色彩但不重 | Otty 更轻,但 Conduit 的场景需要更多视觉线索 |
| 侧栏/主区色差 | 几乎同色,一条细线分隔 | bg-1 vs bg-white,有可感知色差 | Otty 更整体 |

---

## 值得 Conduit 借鉴的

### 1. 侧栏与主区域的色差处理

Otty 侧栏和主区域几乎同色,只靠一条细线分隔,视觉上更整体。Conduit 当前用 `--c-bg-1` 做侧栏底色,和白色主区域有色差。可以考虑进一步减小差异,让整体更干净。

### 2. Hover 态的克制

Otty 的 hover 态非常轻。Conduit 的 `hover-bg` 和 `hover-close` 可以检查是否过重。

### 3. 行高紧凑

Otty 每个 session 行占用空间更小。Conduit 双行结构信息更多,但 session 数量增长到 10+ 时,可以考虑「紧凑模式」只显示单行。

---

## 不应该借鉴的

- **纯文本无 icon 风格**: Conduit 管理多种 Agent(CC, CX, AM, GM...),没有圆形 icon 会失去最直观的类型辨识。
- **Free-form pane 布局**: Conduit 是侧栏终端,三栏固定布局是设计约束。自由拖拽会破坏「轻量、不打扰」的定位。
- **Command palette**: Conduit 已有侧栏 search filter,全局 command palette 对轻量侧栏终端过重。

---

## 结论

Conduit 侧栏在功能设计上已比 Otty 更成熟: Agent 识别、diff stat、分支显示、进度条。Otty 唯一领先的是「视觉轻量感」。

借鉴方向: 在保持现有信息密度的前提下,把视觉重量再降一档。更小的色差、更轻的 hover、更紧凑的间距。
