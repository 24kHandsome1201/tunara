# Tunara 设计系统

## 1. 视觉主张

Tunara 是高密度纸面开发工具。界面像一张有明确层级的工作台：侧栏负责定位，真实终端负责执行，检查面板负责只读上下文。它不使用玻璃拟态，也不把终端包装成聊天产品。

## 2. 色彩

- 默认强调色为 Terracotta `#c2683c`，定义在 `src/styles/tokens.css`，不再提供用户可选的 accent 色板。
- 中性色使用暖白纸面与暖灰墨色，统一采用 OKLCH 表达。
- 侧栏和检查面板使用二级纸面，终端使用主纸面，层级依靠明度与边界，不依靠透明模糊。
- 默认终端调色板与外壳同源：画布背景与前景直接取主纸面与主墨色的 sRGB 等效值，ANSI 色相向暖纸/暖墨调和，常规色对比度保持在 AA 附近。
- 绿色、黄色、红色只表示完成、等待、失败等语义状态。
- 半透明按“层”而不是按“组件白名单”启用：开启窗口透明度时（macOS，`html[data-window-translucent]`），`--c-bg-*` 面底令牌整体带 `--window-bg-opacity` alpha，外壳与面板（标题栏、侧栏、检查面板、SSH 主机面板、文件预览）因此统一半透明；覆盖层（`.overlay-sheet`、`.overlay-palette`、`.settings-dialog`、`.toast-item`、`[role="menu"]`、`[role="listbox"]`）把令牌重新钉回 `-solid` 值保持不透明；文本、终端画布与文件正文中保留透明洞。新增界面只需使用 `--c-bg-*` 令牌即自动符合规则，不要再为某个类名单独写 color-mix。Diff 增删行底色用 `color-mix` 从 `--c-success`/`--c-error` 派生为透明染色，随面板一起叠色。

## 3. 字体

- 拉丁文字、数字、路径与代码使用 JetBrains Mono（打包 400/500/600/700 字重，中间字重不依赖合成加粗）。
- 界面字族以 system-ui 起始，按平台回退到 SF Pro Text、Segoe UI；中文依次回退 PingFang SC、Hiragino Sans GB、Microsoft YaHei 与 Noto Sans SC。
- 等宽字族在 JetBrains Mono 之后经 ui-monospace、SF Mono、Menlo、Cascadia Mono、Consolas 回退，中文以 PingFang SC 与 Noto Sans Mono CJK SC 兜底，保持列对齐。
- 数据默认使用等宽数字，避免状态计数变化时产生水平跳动。

## 4. 圆角

- 按钮 7px。
- 卡片 9px。
- 浮层 14px。
- 只有状态与计数标签允许使用完整胶囊形状。

## 5. 布局

- 标准布局为 272px 侧栏、弹性终端、320px 检查面板。
- 检查面板一次只呈现一种主状态；文件预览占满右栏内容区并取代列表，关闭后无损返回原列表状态。
- 辅助面板是否停靠由终端可用宽度决定（单 pane 至少 480px，每个分栏列 280px），而不是固定的 720/900px 断点。空间不足时检查面板先让路，然后是侧栏。
- 两个覆盖层互斥：窄窗下后打开的一侧会关闭另一侧，避免同时盖住终端。
- 终端按目录分组，活动终端使用白纸卡片与 1px 强调色状态轨。

## 6. 深度

- 主界面使用实色表面、1px 边界和低扩散阴影。
- 检查面板标题栏使用一级纸面，内容区使用二级纸面，预览正文回到主纸面，三层不得混成同一明度。
- 阴影只服务于活动卡片、菜单、通知和覆盖层。
- 普通分区不叠卡片，不使用装饰性渐变。

## 7. 动效

- 交互反馈为 120ms 到 160ms，使用快速淡入、位移和约 0.96 的按压缩放。
- 禁止弹跳、弹性回弹、呼吸光和持续装饰动画。
- 只有连接、读取、执行等真实进行中状态可以使用低幅度加载动效。
- 所有 `transition` / `animation` 必须引用令牌；CSS 与 TSX 中不允许出现字面 `ms`/`s` 时长（由 `tests/design-tokens.test.mjs` 强制）。
  - 时长刻度：`--dur-instant` 60ms（颜色/透明微变）、`--dur-fast` 120ms（按压、菜单入场）、`--dur-base` 160ms（覆盖层/面板入场）、`--dur-slow` 220ms（仅限抽屉等大位移）、`--dur-loading` 1200ms（唯一允许的 infinite）、`--delay-loading-fallback` 200ms、`--dur-toast`/`--dur-toast-long` 4000/12000ms。
  - 缓动只有两条：`--ease-out`（入场/位移）与 `--ease-in-out`（双向状态切换）；禁止 back / elastic / bounce。
  - 位移 `--motion-distance-sm/md/lg` 4/8/12px，入场缩放 `--motion-scale-in` 0.98，按压缩放 `--press-scale` 0.98 与 `--press-scale-icon` 0.96。
- Reduced motion 只有一条链路：`useTheme` 按系统 `prefers-reduced-motion` 写入 `html[data-reduce-motion]`，令牌在 `tokens.css` 中被清零；不经令牌的动画在 `globals.css` 中显式 `animation: none`。

## 7.1 尺寸与层级刻度

- 控件高度：`--h-btn-sm/md/lg` 24/30/34px，输入框 `--h-control` 32px（密集场景 `--h-control-sm` 28px）。
- 图标：`--icon-xs/sm/md` 10/12/14px；状态点 `--dot-sm/md` 6/8px。
- 圆角：按钮 `--r-btn` 7、输入 `--r-input` 8、菜单 `--r-menu` 8、卡片 `--r-card` 9、浮层 `--r-overlay` 14、徽标 `--r-badge(-sm)`、胶囊 `--r-pill`。
- 层级只有一条刻度，backdrop 与同层 dialog 共用同一值、靠 DOM 顺序互相压制：
  `--z-raised` 10（split/resize handle）→ `--z-sticky` 30（终端搜索条）→ `--z-shell` 75（侧栏/面板覆盖）→ `--z-overlay` 300（Modal、SSH 提示、Suspense 兜底）→ `--z-palette` 400（命令面板、全局搜索）→ `--z-toast` 500 → `--z-menu` 600 → `--z-system` 1000（窗口边缘 resize、全屏预览）。
- 组件不写数字 `zIndex`；组件内部的局部叠放（|z| < 10）由测试豁免，其余一律走令牌。

## 8. 可访问性

- 键盘焦点使用统一的强调色焦点环：`outline: var(--focus-ring-w) solid var(--focus-ring-color)` + `var(--focus-ring-offset)` 偏移；输入容器用 `:focus-within` + `--focus-ring-soft` 软环。
- 颜色不作为唯一状态信号，状态必须同时提供文字、图标或形状。
- 支持浅色、深色和跟随系统，所有主题都保持实色层级。
- 中英文文案都必须在紧凑布局中截断或换行，不能挤压主操作。

## 9. 禁止项

- 不使用玻璃模糊作为外壳层级，也不把透明模糊当成侧栏/标题栏/检查面板的深度手段。
- 不使用多套并行 CSS 系统。组件几何保留在 React 样式中，设计令牌和统一交互状态放在 CSS。
- 不用通用聊天壳、Agent 平台或主机管理器的视觉范式覆盖真实终端。
- 不为次要信息新增重复计数、冗余工具条或持续占位的状态卡片。
