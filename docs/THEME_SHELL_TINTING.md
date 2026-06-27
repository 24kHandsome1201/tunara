# 外壳染色：UI 跟随终端预设换肤

## 设计目标

今天选了非 default 的终端预设（Catppuccin / Tokyo Night / One Dark / Solarized / GitHub Light / Rose Pine Dawn），**只有终端区域换了色，侧栏 / 面板 / 标题栏还是中性 light/dark 的灰**，整窗割裂。

本方案让 **UI 外壳跟随终端预设一起换肤**：侧栏、面板、标题栏、命令面板的 `背景 / 边框 / 次级文字` 取自该预设的官方调色板，做到整窗视觉统一。这是 Herdr / Athas / Zed 的做法。

## 设计纪律：参照系

| 产品 | 做法 | 我们取舍 |
|------|------|---------|
| VS Code | `workbench.colorCustomizations` 把上百个 UI 部位逐一绑 token，颗粒度极细 | 太重，不抄 |
| Ghostty / Alacritty | 只染终端，不碰 UI | 我们要超过它 |
| **Zed** | 一套 theme family，`background / surface / element / border / text` 分层语义槽位，编辑器与 UI 共享同一组槽位 | **采用此路子** |

核心决策：**不给每套预设手写上百个变量**。定义一组"语义槽位"，每套预设只填这组槽位的值。

## 范围边界（守住定位与可读性）

**染（外壳中性色）**：
`--c-bg-white / -1 / -2 / -3`、`--c-bg-hover`、`--c-border-1 / -2 / -3`、`--c-text-primary / -2..-7`、玻璃材质回退色。

**不染（语义色，保持可读性 + 守不做清单）**：
- Agent 徽章色（`--c-agent-*`）——品牌识别色，跟着换肤会丢辨识度。
- Diff 红绿（`--c-diff-*`）、success / error / warning / info——语义恒定，换肤后仍需"红=删、绿=增"。
- 强调色（`--c-accent`）——用户独立选的，与终端预设正交，**两者叠加**：选 Catppuccin 外壳 + Indigo 强调，外壳走 Catppuccin、聚焦环/选区走 Indigo。

> 这条边界同时是"不做清单"的护栏：不把语义信息交给主题去改，终端仍是终端。

## 槽位语义模型

每套预设按官方规范映射到 6 个 UI 槽位。命名沿用 Catppuccin 规范术语作为锚（其它预设找等价层）：

| UI 槽位 | 语义 | Catppuccin 锚 | 对应 CSS 变量 |
|---------|------|--------------|--------------|
| `surface-deepest` | 最底（标题栏/根背景） | Crust | `--c-bg-white`（注：变量名历史叫 white，深色下是最深面） |
| `surface-base` | 主工作面（终端容器背景一致） | Base/Mantle | `--c-bg-1` |
| `surface-raised` | 抬升面（卡片/面板分区） | Surface0 | `--c-bg-2` |
| `surface-overlay` | 浮层（输入框/下拉/hover 底） | Surface1 | `--c-bg-3` |
| `border` | 分隔线（三档：弱/中/最弱） | Surface0/1 | `--c-border-1/2/3` |
| `text` | 文字层级（主→7 级渐隐） | Text → Overlay0 | `--c-text-primary / -2..-7` |
| `hover` | 悬停底色 | Surface0 提亮 | `--c-bg-hover` |

派生规则：
- `surface-base` 与终端 `background` 取**同色或差 ≤4% 亮度**，让侧栏和终端无缝（这是"侧栏终端"的核心观感）。
- 相邻嵌套面（`surface-base` vs `surface-raised`）亮度差 **≥4%**，否则白底白卡看不见（见 design gotcha）。
- `text-primary` 用预设 `foreground`；`text-2..-7` 沿 foreground → overlay 方向七级线性插值。
- 染色后强制校验：`text-primary` 对 `surface-base` 对比度 ≥ 4.5:1。

---

## 7 套预设 UI token 映射表

值从各预设**官方调色板**推导（Catppuccin Mocha / Tokyo Night / One Dark / Solarized / GitHub Primer / Rosé Pine Dawn 官方规范）。终端 `background` 列即现有 `terminalTheme.ts` 的值，用作 `surface-base` 锚点。

### 暗色族

#### Catppuccin（Mocha）
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#11111b` | Crust |
| `--c-bg-1` | `#1e1e2e` | Base（= 终端背景，无缝） |
| `--c-bg-2` | `#181825` | Mantle |
| `--c-bg-3` | `#313244` | Surface0 |
| `--c-bg-hover` | `#45475a` | Surface1 |
| `--c-border-1` | `#313244` | Surface0 |
| `--c-border-2` | `#45475a` | Surface1 |
| `--c-border-3` | `#28283a` | Crust↔Surface0 |
| `--c-text-primary` | `#cdd6f4` | Text |
| `--c-text-2` | `#bac2de` | Subtext1 |
| `--c-text-3` | `#a6adc8` | Subtext0 |
| `--c-text-4` | `#9399b2` | Overlay2 |
| `--c-text-5` | `#7f849c` | Overlay1 |
| `--c-text-6` | `#6c7086` | Overlay0 |
| `--c-text-7` | `#585b70` | Surface2 |

#### Tokyo Night
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#16161e` | bg_dark |
| `--c-bg-1` | `#1a1b26` | bg（= 终端背景） |
| `--c-bg-2` | `#1f2335` | bg_highlight |
| `--c-bg-3` | `#292e42` | bg_visual |
| `--c-bg-hover` | `#343a52` | — |
| `--c-border-1` | `#292e42` | — |
| `--c-border-2` | `#3b4261` | — |
| `--c-border-3` | `#222230` | — |
| `--c-text-primary` | `#c0caf5` | fg |
| `--c-text-2` | `#a9b1d6` | fg_dark |
| `--c-text-3` | `#9aa5ce` | — |
| `--c-text-4` | `#828bb8` | — |
| `--c-text-5` | `#6c7394` | — |
| `--c-text-6` | `#565f89` | comment |
| `--c-text-7` | `#414868` | terminal black |

#### One Dark
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#21252b` | darker chrome |
| `--c-bg-1` | `#282c34` | bg（= 终端背景） |
| `--c-bg-2` | `#2c313a` | panel |
| `--c-bg-3` | `#3b4048` | raised |
| `--c-bg-hover` | `#3e4451` | selection-ish |
| `--c-border-1` | `#3b4048` | — |
| `--c-border-2` | `#4b5263` | — |
| `--c-border-3` | `#31363f` | — |
| `--c-text-primary` | `#abb2bf` | fg |
| `--c-text-2` | `#9da5b4` | — |
| `--c-text-3` | `#828997` | — |
| `--c-text-4` | `#6f7787` | — |
| `--c-text-5` | `#5c6370` | comment |
| `--c-text-6` | `#4f5666` | — |
| `--c-text-7` | `#3f4451` | — |

#### Solarized（Dark）
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#002129` | base03 deepened |
| `--c-bg-1` | `#002b36` | base03（= 终端背景） |
| `--c-bg-2` | `#073642` | base02 |
| `--c-bg-3` | `#0a4250` | base02 raised |
| `--c-bg-hover` | `#0e4a59` | — |
| `--c-border-1` | `#073642` | base02 |
| `--c-border-2` | `#0d4d5c` | — |
| `--c-border-3` | `#05303b` | — |
| `--c-text-primary` | `#93a1a1` | base1 |
| `--c-text-2` | `#839496` | base0 |
| `--c-text-3` | `#768d8d` | — |
| `--c-text-4` | `#6a8080` | — |
| `--c-text-5` | `#586e75` | base01 |
| `--c-text-6` | `#4a5e64` | — |
| `--c-text-7` | `#3b4d52` | — |

> Solarized 偏青绿、对比度本就偏低，染色后重点校验 `text-primary` 对比度，必要时把 primary 提到 `#a6b3b3`。

### 亮色族

#### GitHub Light（Primer）
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#ffffff` | canvas.default（= 终端背景） |
| `--c-bg-1` | `#ffffff` | canvas |
| `--c-bg-2` | `#f6f8fa` | canvas.subtle |
| `--c-bg-3` | `#eaeef2` | canvas.inset |
| `--c-bg-hover` | `#eef1f4` | — |
| `--c-border-1` | `#d0d7de` | border.default |
| `--c-border-2` | `#afb8c1` | border.muted→strong |
| `--c-border-3` | `#e4e8ec` | — |
| `--c-text-primary` | `#1f2328` | fg.default |
| `--c-text-2` | `#24292f` | — |
| `--c-text-3` | `#57606a` | fg.muted |
| `--c-text-4` | `#6e7781` | — |
| `--c-text-5` | `#838c95` | fg.subtle |
| `--c-text-6` | `#a0a8b0` | — |
| `--c-text-7` | `#bcc4cc` | — |

#### Rose Pine Dawn
| 变量 | 值 | 官方锚 |
|------|-----|-------|
| `--c-bg-white` | `#fffaf3` | surface |
| `--c-bg-1` | `#faf4ed` | base（= 终端背景） |
| `--c-bg-2` | `#fffaf3` | surface |
| `--c-bg-3` | `#f2e9e1` | overlay |
| `--c-bg-hover` | `#f4ede8` | highlight low |
| `--c-border-1` | `#f2e9e1` | overlay |
| `--c-border-2` | `#dfdad9` | highlight med |
| `--c-border-3` | `#f4ede8` | highlight low |
| `--c-text-primary` | `#575279` | text |
| `--c-text-2` | `#6e6a86` | subtle |
| `--c-text-3` | `#797593` | muted |
| `--c-text-4` | `#8c899f` | — |
| `--c-text-5` | `#9893a5` | — |
| `--c-text-6` | `#b5afb8` | — |
| `--c-text-7` | `#cecacd` | — |

---

## 注入机制改造（复用现有强调色通道）

现有 `src/app/useTheme.ts` 已经会把强调色派生变量动态写到 `document.documentElement.style`。**外壳染色复用同一通道**，不新增渲染路径。

### 数据：把映射表搬进 `terminalTheme.ts`

新增一个导出，与现有 7 个 xterm theme 对象并列：

```ts
// terminalTheme.ts —— 每套预设的 UI 槽位（仅非 default 预设需要）
export const SHELL_TINTS: Record<string, Record<string, string>> = {
  catppuccin: {
    "--c-bg-white": "#11111b", "--c-bg-1": "#1e1e2e", "--c-bg-2": "#181825",
    "--c-bg-3": "#313244", "--c-bg-hover": "#45475a",
    "--c-border-1": "#313244", "--c-border-2": "#45475a", "--c-border-3": "#28283a",
    "--c-text-primary": "#cdd6f4", "--c-text-2": "#bac2de", "--c-text-3": "#a6adc8",
    "--c-text-4": "#9399b2", "--c-text-5": "#7f849c", "--c-text-6": "#6c7086", "--c-text-7": "#585b70",
    // 玻璃回退跟随 base
    "--c-bg-white-glass": "rgba(30,30,46,0.78)", "--c-bg-1-glass": "rgba(30,30,46,0.72)",
    "--c-bg-2-glass": "rgba(24,24,37,0.65)", "--c-bg-glass-fallback": "#181825",
  },
  "tokyo-night": { /* …同结构… */ },
  "one-dark":    { /* … */ },
  solarized:     { /* … */ },
  "github-light":{ /* … */ },
  "rose-pine-dawn": { /* … */ },
  // default 不在表里 → 回落到 tokens.css 的 :root / .dark
};
```

### 应用：`useTheme.ts` 增加一个 effect

在现有 `useTheme()` 里，订阅 `terminalTheme`，按下述顺序刷新（**顺序很重要**：先清旧、定明暗、铺底、染壳、盖强调）：

```ts
const terminalTheme = useUIStore((s) => s.terminalTheme);

useEffect(() => {
  const root = document.documentElement;
  // 1) 先清掉上一次染的壳变量（避免 default 残留 Catppuccin）
  for (const key of SHELL_TINT_KEYS) root.style.removeProperty(key);

  if (terminalTheme === "default") return; // 回落 tokens.css 的 :root/.dark

  // 2) 暗色预设要带上 .dark（让没被染的语义色用暗版）
  const dark = isTerminalThemeDark(terminalTheme, theme);
  root.classList.toggle("dark", dark);

  // 3) 染壳：写入该预设的 UI 槽位（盖住 tokens.css）
  const tint = SHELL_TINTS[terminalTheme];
  if (tint) for (const [k, v] of Object.entries(tint)) root.style.setProperty(k, v);

  // 4) 强调色派生变量保持最后注入（已在另一个 effect，确保它在染壳之后）
}, [terminalTheme, theme]);
```

要点：
- **明暗类与染色解耦但要协同**：选了暗色预设但 app theme 是 light 时，必须 `toggle("dark", true)`，否则未染的语义色（agent/diff）会用亮版，跟暗壳打架。
- **default 必须清干净**：用固定的 `SHELL_TINT_KEYS` 数组 `removeProperty`，让变量回落到 CSS 文件定义，而不是残留上一套。
- **强调色 effect 排在染壳之后**：`--c-accent*` 不在 `SHELL_TINT_KEYS` 里，不会被清，但要保证写入时机在染壳 setProperty 之后（React effect 顺序按声明顺序，把强调 effect 放后面即可）。
- xterm 那条 `useTerminalRuntimeSync` **完全不用动**——它已经实时刷终端配色，外壳染色是纯 UI 侧并行通道。

### 持久化 / 闪烁

`terminalTheme` 已在 `PERSIST_KEYS` 里。冷启动防闪：把"读 config 后第一帧同步染壳"接到现有的 boot 流程（强调色已有同样处理），避免先白后染的闪。

---

## 落地步骤（一次性 7 套）

1. `terminalTheme.ts` 新增 `SHELL_TINTS`（6 套，default 不列）+ 导出 `SHELL_TINT_KEYS`（所有被染变量名的并集，固定数组）。
2. `useTheme.ts` 加上面的 effect；确认强调色 effect 在其后。
3. 校验：逐套截图侧栏 + 终端 + 命令面板 + 设置面板；跑对比度检查（`text-primary` vs `bg-1` ≥ 4.5:1）。
4. 边角：
   - 选区背景仍由强调色覆写（现状不变），确认染壳后选区仍清晰。
   - `--shadow-*` 暗壳下用 `.dark` 的阴影（已随 toggle 生效）。
   - 玻璃材质（vibrancy）回退色跟随 base，已在 SHELL_TINTS 内。
5. Settings 里终端主题网格的预览卡：可顺带把卡片背景显示成该预设的 `bg-1`，让用户选之前就看到外壳效果（增强项，可选）。

## 验收清单

- [ ] 选 Catppuccin：侧栏 / 面板 / 标题栏 / 命令面板背景变成 Mocha 深紫蓝，与终端无缝。
- [ ] 选 GitHub Light：整窗变成 GitHub 的冷白灰，终端和侧栏同源。
- [ ] 切回 default：外壳干净回落到 light/dark，无 Catppuccin 残留。
- [ ] Catppuccin + Indigo 强调：外壳走 Catppuccin，聚焦环 / 选区走 Indigo（两者正交叠加）。
- [ ] agent 徽章、diff 红绿在任何预设下都保持原品牌/语义色，不被染。
- [ ] 每套预设下 `text-primary` 对 `bg-1` 对比度 ≥ 4.5:1。
- [ ] 冷启动直接进 Catppuccin 不闪白。
- [ ] 窄窗折叠态、玻璃材质回退（Linux WebKitGTK）下外壳色正确。
```
