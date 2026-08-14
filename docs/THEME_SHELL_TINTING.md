# 界面与终端配色规范

Tunara 使用一个统一、互斥的“界面与终端配色”选择器。命名配色会同时改变 xterm 与应用外壳；浅色、深色和跟随系统使用 Tunara 默认配色。设置页不得再把界面主题和终端 palette 表现为两个可同时选中的控件。

设置页文案：

- 中文标题：**界面与终端配色**
- 中文说明：**命名配色会同时应用到终端和应用界面。浅色、深色和跟随系统使用 Tunara 默认配色。**
- English title: **Terminal & interface color scheme**
- English description: **Named schemes style the terminal and app interface together. Light, Dark, and System use Tunara’s default palette.**

## 选项与状态映射

选择器依次提供：跟随系统、浅色、深色、GitHub Light、Rose Pine Dawn、Catppuccin、Tokyo Night、One Dark、Solarized。

配置格式保持不变，不做 schema 迁移：

| 用户选择 | `theme` | `terminalTheme` / `appearance.terminal_theme` |
|---|---|---|
| 跟随系统 | `system` | `default` |
| 浅色 | `light` | `default` |
| 深色 | `dark` | `default` |
| 任一命名配色 | 保留现值，供以后切回默认配色时使用 | 对应预设 key |

命名配色生效时，底层 `theme` 不应在设置 UI 中显示为第二个选中项。选择浅色、深色或跟随系统时，必须同时把 `terminalTheme` 重置为 `default`，使终端与外壳立即回到 Tunara 默认 palette。

## 运行时契约

- `terminalTheme=default` 时，终端与外壳共同跟随 `theme`；只有 `theme=system` 时才响应系统 `prefers-color-scheme` 变化。
- 暗色命名配色 Catppuccin、Tokyo Night、One Dark、Solarized 强制外壳使用 `.dark`；亮色命名配色 GitHub Light、Rose Pine Dawn 强制使用亮色外壳。
- 命名配色通过同一状态同时驱动 `getTerminalTheme()` 与 shell tint，终端运行时换色后继续刷新 WebGL glyph atlas。
- 切回 `default` 时必须移除所有 shell-tint inline CSS 变量并回落到 `tokens.css`，不得残留上一套命名配色。
- 冷启动从 `tunara.boot.appearance` 恢复 `theme`、`terminalTheme` 和 `accent`，首帧同步设置明暗类、外壳 token、终端 canvas 背景与强调色，避免闪白或闪色。
- Accent 与命名配色保持正交：外壳中性色来自命名配色，焦点、选区等强调色继续来自用户选择。

运行时与冷启动必须共享 `src/styles/terminalTheme.ts` 和 `src/styles/shell-tint-boot.ts` 的同一份预设、明暗分类和 token key，不能复制另一份映射。

## 外壳 token 边界

命名配色只覆盖中性外壳语义槽位：

- 背景与玻璃回退：`--c-bg-white`、`--c-bg-1`、`--c-bg-2`、`--c-bg-3`、hover 与 glass fallback；
- 边框：`--c-border-1`、`--c-border-2`、`--c-border-3`；
- 文本层级：`--c-text-primary` 到 `--c-text-7`。

以下语义不随命名配色改变：Agent 徽章、diff 红绿、success/error/warning/info，以及 `--c-accent` 和其派生值。

具体色值的唯一事实来源是 `src/styles/terminalTheme.ts`；本文不复制易漂移的 token 明细。每个命名配色必须满足：

- 7 级文本在 5 个 shell surface 上均至少 4.5:1；
- `--c-border-2` 在相关 surface 上至少 3:1；
- terminal `surface-base` 与 terminal background 同色或亮度差不超过约 4%；
- 相邻嵌套 surface 仍有可感知层次。

## 选择器与预览

- 容器使用 `role="radiogroup"`，每项使用 `role="radio"` 和准确的 `aria-checked`。
- 只有当前项进入 Tab 顺序；方向键及 Home/End 在选项间移动并选中。
- 选中态同时使用圆点、边框与字重等非颜色信号，不能只依赖颜色。
- 中英文标题、说明及所有名称在窄窗口下允许自然换行，不得截断。
- 每张卡展示小型整窗预览，至少区分 titlebar、sidebar、terminal、panel、边界和文字层级；禁止退化为只有几条终端文本线的色块。
- “跟随系统”预览反映当前系统明暗；命名配色预览使用其实际 shell tint 与 xterm palette。

## 验证

自动化验证覆盖：

- 选择命名配色后 shell 与 terminal canvas 同步更新；
- 从命名配色选择浅色、深色或跟随系统后映射为 `terminalTheme=default`；
- 单选互斥、ARIA 语义、键盘漫游与整窗预览结构；
- shell tint 对比度、冷启动恢复、xterm runtime recolor 与 WebGL atlas 刷新。

原生 Tauri 视觉验收至少覆盖 Catppuccin、GitHub Light、默认 + System，并检查 settings、sidebar、titlebar、panel、command palette、workspace/pure、窄窗口、reduced transparency 与冷启动。详见 [`VISUAL_QA.md`](./VISUAL_QA.md)。

新增命名配色时必须同时提供 xterm palette、shell semantic slots、明暗分类、AA 对比度测试和代表性原生视觉 QA。
