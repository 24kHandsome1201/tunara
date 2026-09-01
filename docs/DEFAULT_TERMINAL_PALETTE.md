# 默认终端调色板（纸面 / 暖墨）

默认 Light/Dark 终端调色板定义在 `src/styles/terminalTheme.ts`，与
`src/styles/tokens.css` 的纸面 token 同源：画布背景与前景直接取主纸面
（`--c-bg-white`）与主墨色（`--c-text-primary`）的 sRGB 等效值，使 WebGL
渲染的终端画布与侧栏、标题栏之间没有冷暖或明度接缝。

已删除的命名主题不再提供官方调色板；旧配置回退到 System。
本文件只约束 `default` 终端主题。

## 浅色「纸面」

画布 `#fffdfb`（= `--c-bg-white`），光标 `#241e1a`，选区 `#c2683c44`
（运行时随用户强调色覆写）。

| 槽位 | 色值 | 对画布对比度 | 说明 |
| --- | --- | --- | --- |
| foreground | `#241e1a` | 16.2:1 | = `--c-text-primary`，主墨色 |
| black | `#3a332a` | 12.3:1 | 暖黑，避免纯黑的生硬 |
| red | `#b3261e` | 6.4:1 | |
| green | `#2e7d32` | 5.1:1 | |
| yellow | `#8f6200` | 5.3:1 | 亮底上黄色必须偏棕才可读 |
| blue | `#1a5fb4` | 6.2:1 | |
| magenta | `#8e3fa8` | 6.0:1 | |
| cyan | `#0a7c86` | 4.9:1 | |
| white | `#efe9e0` | 1.2:1 | 预留给深色底的 TUI 程序 |
| brightBlack | `#6f675b` | 5.5:1 | 注释/弱化文本，保持 AA |
| brightRed | `#c5221f` | 5.7:1 | |
| brightGreen | `#188038` | 5.0:1 | |
| brightYellow | `#b06000` | 4.6:1 | |
| brightBlue | `#1967d2` | 5.3:1 | |
| brightMagenta | `#a142f4` | 4.5:1 | |
| brightCyan | `#0e8a94` | 4.1:1 | 亮青在亮底上的可读性上限 |
| brightWhite | `#ffffff` | 1.0:1 | 预留给深色底的 TUI 程序 |

## 深色「暖墨」

画布 `#0f0b09`（= 深色 `--c-bg-white`），光标 `#e6e0dc`，选区 `#e0907066`
（运行时随用户强调色覆写）。

| 槽位 | 色值 | 对画布对比度 | 说明 |
| --- | --- | --- | --- |
| foreground | `#e6e0dc` | 15.0:1 | = 深色 `--c-text-primary` |
| black | `#4a4238` | 2.0:1 | 深底上的「黑」需要可辨认 |
| red | `#f47067` | 6.9:1 | |
| green | `#8edb8c` | 11.8:1 | |
| yellow | `#e3b341` | 10.1:1 | |
| blue | `#6ea8fe` | 8.1:1 | |
| magenta | `#d2a8ff` | 10.1:1 | |
| cyan | `#56d4dd` | 11.1:1 | |
| white | `#e8e2d8` | 15.2:1 | |
| brightBlack | `#8a8175` | 5.1:1 | 注释/弱化文本，保持 AA |
| brightRed | `#ff938a` | 9.1:1 | |
| brightGreen | `#a9f0a4` | 14.6:1 | |
| brightYellow | `#ffcf5c` | 13.4:1 | |
| brightBlue | `#96c0ff` | 10.5:1 | |
| brightMagenta | `#e2c5ff` | 12.8:1 | |
| brightCyan | `#7ee7ef` | 13.6:1 | |
| brightWhite | `#fdfbf7` | 19.0:1 | |

## 修改守则

- 画布与前景必须与 `tokens.css` 的 `--c-bg-white` / `--c-text-primary`
  保持同一份色值（OKLCH 的 sRGB 等效值）；改动 token 时同步更新本表与
  `terminalTheme.ts`，`tests/shell-tint-contrast.test.mjs` 的画布同步测试会
  拦住漂移。
- 常规 ANSI 色（red…cyan）对画布对比度不低于 4.4:1；brightBlack 不低于
  4.5:1；亮色组允许略低，但必须与对应常规色保持可区分。
- white / brightWhite 是 TUI 程序在反向底上使用的槽位，不以其在画布上的
  对比度评判。
- 选区色不需要手工维护：`getTerminalTheme` 在运行时按用户强调色以
  44/66 透明度重算；表中的静态值只在强调色缺失时使用。
- 设置页配色卡片的预览 fallback（`controls.tsx` 的
  `terminalThemePreviewColors`）使用同一份 sRGB 等效值，改动调色板时一并
  更新；`tests/ui/settings-color-scheme.test.tsx` 有对应断言。
