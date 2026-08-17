# 终端背景（可选）

**已落地。** 默认关闭：不打开设置开关时，终端画布仍是当前主题的实色背景，和改之前一样。

这是周边能力，不是外壳毛玻璃。侧栏、标题栏、检查器、状态栏、文件预览继续用实色纸面。

## 用户能做什么

设置 → 终端 → **终端背景**：

1. 开关。关掉立刻回到当前主题实色；自定义图片仍留在本机，直到点「移除图片」。
2. 三张内置纹理（纸纹 / 细噪 / 纤维）或本机 PNG / JPEG / WebP / GIF。
3. 模糊 0–40px，遮罩 50–95%。浅色主题和自定义照片会自动提高遮罩，保证字对比度。

系统「降低透明度」开启时，即使开关是开的，终端也保持实色。

行内图（SIXEL / IIP）叠在背景之上，可同时开。

## 图层

```
侧栏 / 标题栏 / 检查器 / 状态栏 / 文件预览     实色，永远盖住
终端列（分栏共用一张）
  纹理或缩小后的照片
  CSS blur（打在缩小副本上，不打 6K 原图）
  主题色 veil
  透明 xterm 字形（ANSI 色仍不透明）
```

## 代码

| 部分 | 入口 |
|------|------|
| 纯逻辑（对比度、遮罩下限、默认关） | [`src/modules/terminal/lib/terminal-wallpaper.ts`](../src/modules/terminal/lib/terminal-wallpaper.ts) |
| 内置纹理 | [`terminal-wallpaper-textures.ts`](../src/modules/terminal/lib/terminal-wallpaper-textures.ts) |
| 自定义图拷贝 | [`src-tauri/src/modules/wallpaper.rs`](../src-tauri/src/modules/wallpaper.rs) → `~/.config/tunara/wallpaper/` |
| 画布层 | [`src/ui/TerminalWallpaper.tsx`](../src/ui/TerminalWallpaper.tsx) · [`MainArea.tsx`](../src/ui/MainArea.tsx) |
| xterm 透明 | [`terminal-instance.ts`](../src/modules/terminal/lib/terminal-instance.ts) · [`useTerminalRuntimeSync.ts`](../src/ui/useTerminalRuntimeSync.ts) |
| 设置 | [`TerminalSettings.tsx`](../src/ui/overlays/settings/TerminalSettings.tsx) |

配置键：`terminal_wallpaper`（默认 `false`）、`terminal_wallpaper_source`、`terminal_wallpaper_blur`、`terminal_wallpaper_veil`。旧配置缺这些键时按关闭处理。
