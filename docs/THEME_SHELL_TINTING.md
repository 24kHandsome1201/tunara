# 界面与终端配色规范

Tunara 使用一个统一、互斥的“界面与终端配色”选择器。浅色、深色和跟随系统共用 Tunara 默认纸面 palette，终端与外壳始终同源。设置页不得再把界面主题和终端 palette 表现为两个可同时选中的控件，也不再提供命名配色或强调色选择。

设置页文案：

- 中文标题：**界面与终端配色**
- 中文说明：**浅色、深色和跟随系统使用 Tunara 默认配色。**
- English title: **Terminal & interface color scheme**
- English description: **Light, Dark, and System use Tunara’s default palette.**

## 选项与状态映射

选择器依次提供：跟随系统、浅色、深色。

配置格式保持不变，不做 schema 迁移：

| 用户选择 | `theme` | `appearance.terminal_theme`（写入时固定） |
|---|---|---|
| 跟随系统 | `system` | `default` |
| 浅色 | `light` | `default` |
| 深色 | `dark` | `default` |

已删除的命名配色（GitHub Light、Rose Pine Dawn、Catppuccin、Tokyo Night、One Dark、Solarized）若仍出现在旧 `config.toml` 或 `tunara.boot.appearance` 里，必须优雅回退到 System：`theme=system`，`terminal_theme=default`。不得崩溃或白屏。

## 运行时契约

- 终端与外壳共同跟随 `theme`；只有 `theme=system` 时才响应系统 `prefers-color-scheme` 变化。
- 切到浅色/深色/跟随系统时必须移除所有历史 shell-tint inline CSS 变量并回落到 `tokens.css`，不得残留上一套命名配色。
- 冷启动从 `tunara.boot.appearance` 恢复 `theme` 和固定强调色，首帧同步设置明暗类、终端 canvas 背景与强调色，避免闪白或闪色。旧缓存里的 `terminalTheme` 若是已删预设，同样回退到 System。
- 强调色固定为 Terracotta `#c2683c`，与暖纸面同源。旧配置里的其他 accent 在加载时被覆盖为该默认值。

运行时与冷启动必须共享 `src/styles/terminalTheme.ts` 和 `src/styles/shell-tint-boot.ts` 的同一份 token key，不能复制另一份映射。

## 外壳 token 边界

默认浅色/深色外壳来自 `tokens.css`。以下语义不随主题改变：Agent 徽章、diff 红绿、success/error/warning/info，以及 `--c-accent` 和其派生值。

具体色值的唯一事实来源是 `src/styles/terminalTheme.ts` 与 `src/styles/tokens.css`；本文不复制易漂移的 token 明细。默认浅色与深色必须满足：

- 7 级文本在 5 个 shell surface 上均至少 4.5:1；
- `--c-control-border` 在相关 surface 上至少 3:1；
- terminal canvas 与主纸面同色。

## 选择器与预览

- 容器使用 `role="radiogroup"`，每项使用 `role="radio"` 和准确的 `aria-checked`。
- 只有当前项进入 Tab 顺序；方向键及 Home/End 在选项间移动并选中。
- 选中态同时使用圆点、边框与字重等非颜色信号，不能只依赖颜色。
- 中英文标题、说明及所有名称在窄窗口下允许自然换行，不得截断。
- 每张卡展示小型整窗预览，至少区分 titlebar、sidebar、terminal、panel、边界和文字层级。
- “跟随系统”预览反映当前系统明暗。

## 验证

自动化验证覆盖：

- 选择浅色、深色或跟随系统后 shell 与 terminal canvas 同步更新；
- 已删命名配色从配置和 boot cache 回退到 System；
- 单选互斥、ARIA 语义、键盘漫游与整窗预览结构；
- 默认 palette 对比度、冷启动恢复、xterm runtime recolor 与 WebGL atlas 刷新。

原生 Tauri 视觉验收覆盖默认浅色、深色与 System，并检查 settings、sidebar、titlebar、panel、command palette、workspace/pure、窄窗口、reduced transparency 与冷启动。详见 [`VISUAL_QA.md`](./VISUAL_QA.md)。
