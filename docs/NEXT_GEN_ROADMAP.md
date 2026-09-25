# Tunara 下一代升级路线（v3.1 → v4.0）

基于 main @ 8ef8425（v3.0.3 + 未发布的 SSH/HerdR/半透明系列）、[GOAL.md](./GOAL.md)、[ROADMAP.md](./ROADMAP.md)、`docs/archive/PRODUCT_REVIEW.md`、`docs/archive/TERMINAL_COMPETITIVE_GAPS.md` 和近两周提交整理。2026-09-25 经产品批准。不是发版日期承诺；阶段内新增范围仍按 GOAL.md 先证明高频价值并明确边界。

## 0. 现状判断

| 维度 | 现状 | 信号 |
|---|---|---|
| 产品主线 | 真实终端 + 按主机/目录分组的侧栏 + 只读 Git review + 有边界的文件/SSH | GOAL 明确：没有自动进入的下一阶段 |
| 最近两周重心 | SSH 失败码/跳板机、HerdR/tmux/zellij 感知、半透明外壳、侧栏会话身份 | 用户真实在用 **SSH + 多路复用器 + Agent**，这是下一代的发力点 |
| 渲染 | 3.0.3 为修 CJK/字形错位，**所有平台退回 DOM 渲染** | 大输出、多分屏下性能倒退；WebGL 代码（atlas 隔离/fallback）仍在但闲置 |
| 代码体量 | `ssh/hosts.rs` 3.6k、`ssh/sftp.rs` 3.3k、`ssh/connection.rs` 2.8k、`FilePreview.tsx` 1.9k、`FileExplorer.tsx` 1.6k 行 | SSH 模块已是回归主风险源 |
| 测试 | Node 逻辑 + Vitest(happy-dom) + cargo test；**没有 E2E / 真实 webview / 真实 SSH 门禁** | ROADMAP 第 1 项“真实环境回归矩阵”一直未落地 |
| 性能预算 | App chunk 已贴线（刚靠懒加载 Inspector 拉回预算内） | 新功能必须默认懒加载 |
| 平台 | 仅 macOS Apple Silicon 正式支持 | Linux/Windows 实验性 |
| 安全 | RUSTSEC-2023-0071（rsa）接受风险；russh 精确锁 0.61.2 | 需要周期性 bump 流程 |

结论：下一代不应再“铺新面”，而是 **①把 3.x 的稳定性债还掉 → ②把终端本职补齐到 Ghostty/iTerm 水位 → ③把“SSH + 多路复用器 + Agent”做成 Tunara 的差异化闭环**。

---

## 1. v3.1「稳态」——还债、立门禁（约 2–3 个 session）

目标：发布 main 上积压的修复，同时补上以后每次发版都要用的护栏。

1. **发布积压改动**：SSH 失败码/跳板机卡片、HerdR 状态、半透明/模糊、侧栏会话身份等整理进 CHANGELOG，发 3.1.0。
2. **E2E 冒烟门禁（新）**
   - 前端层：Playwright 跑 Vite 页面 + mock Tauri IPC（`@tauri-apps/api/mocks`），覆盖新建会话、分屏、Inspector 切换、SSH 连接表单、设置页。
   - 真实层：Linux CI 用 `tauri-driver`(WebDriver) 跑 1–2 条黄金路径；macOS 保留手动 QA 清单（`archive/VISUAL_QA.md`）。
3. **真实 SSH 回归矩阵**（ROADMAP 第 1 项落地）：CI 里起 `openssh-server` 容器 + 跳板机容器，矩阵覆盖 key / password / keyboard-interactive / agent、bash / zsh、首连 host key、被动断开重连、ProxyJump、大目录 grep。已有 `benchmark` feature 下的 RTT fixture 可复用。
4. **SSH 模块拆分**（纯重构，零行为变化）：`hosts.rs` → profile 存储 / config 导入 / 分组；`sftp.rs` → 浏览 / 读写 / safe-write；`connection.rs` → 握手 / 认证状态机 / generation 发布。前端 `FilePreview.tsx` 按预览类型拆子组件并懒加载。
5. **依赖节奏**：固定每个 minor 做一次 russh / Tauri / xterm bump checklist（沿用 `DEPENDENCY_ADVISORIES.md`），关注 russh 是否提供无 RSA 构建以关闭 RUSTSEC-2023-0071。

验收：CI 新增 e2e + ssh-matrix 两个 job 且为必需检查；SSH 源文件单文件 < 1.5k 行；bundle 预算不变。

---

## 2. v3.2「终端本职」——渲染与协议回到一线（约 2–3 个 session）

1. **GPU 渲染回归（最高优先级）**
   - 复现 3.0.3 的 CJK/ANSI 字形问题，定位是 addon-webgl atlas 合并还是宽度测量不一致。
   - 方案：WebGL 作为“设置 → 终端 → 渲染器（自动/GPU/兼容）”，自动模式在字形自检通过后才启用；已有 `terminal-benchmark.ts` 扩成发版前基准（大输出吞吐、4 分屏 FPS、CJK 对齐截图比对）。
   - 跟踪 xterm.js 6.x 的 WebGL/DOM 修复，必要时评估 `@xterm/addon-webgl` 新版。
2. **Unicode grapheme 宽度**：接 `@xterm/addon-unicode-graphemes`（或 Unicode 15 宽度表），和 CJK 标点压缩禁用逻辑统一测试。
3. **跨会话搜索**：在已有命令块 / scrollback marker 基础上做 ⌘⇧F 全会话搜索（只搜内存中的 scrollback，不做持久索引——守住“不做 Event Store”的边界）。
4. **多窗口（候选，需批准）**：竞品全员具备、Tunara 单窗。先做“把会话拖出为新窗口”，store 需要按窗口分片，快照结构升级；成本较高，建议单独立项。
5. **Kitty keyboard 协议**：继续等 xterm.js 上游，本阶段只做跟踪与开关预留。

验收：大输出吞吐恢复到 WebGL 基线的 ±10%；CJK/emoji 对齐截图比对通过；跨会话搜索 1 万行/会话 × 10 会话 < 100 ms。

---

## 3. v3.3「远程工作台」——SSH + 多路复用器 + Agent 闭环（约 3 个 session）

这是 Tunara 相对 iTerm/Ghostty/Warp 最有差异化的方向，也是最近提交最集中的地方。

1. **多路复用器适配层**：把 `herdr.rs` 的“只读快照 → 白名单字段 → IPC”模式抽象成 `MultiplexerAdapter`，接入 tmux（`tmux list-panes -F`）和 zellij（`zellij action list-clients`/插件）。侧栏、Inspector 跟随焦点 pane、Needs-you 聚合全部走统一接口。
2. **远程 Agent 感知**：SSH 会话内的 Claude Code / Codex 状态目前依赖 OSC；增加可选的远程 hook（post-connect 命令已有基础）把状态通过 OSC 回传，不在远端常驻进程。
3. **远程 Preview**：Preview 已支持显式 SSH tunnel，补“终端里出现远端 localhost URL → 一键建本地转发并打开 Preview”，复用 forwarding 模块。
4. **连接体验**：跳板机多跳链路可视化、断线自动重连策略按主机持久化（已部分落地）、连接复用状态在标题栏可见。
5. **SSH 配置兼容性**：`Include`、`Match host`、`IdentityAgent`（1Password/Secretive）等 ssh_config 常用指令，按真实用户 config 做兼容矩阵。

验收：tmux/zellij/HerdR 三者在侧栏表现一致；ssh-matrix 覆盖多跳 + 1Password agent；远程 URL → Preview 两步内完成。

---

## 4. v4.0「平台」——候选方向（需产品决策）

| 选项 | 价值 | 成本/风险 |
|---|---|---|
| A. Linux 正式支持（AppImage/deb，签名 + 自动更新） | 远程开发用户很多在 Linux 桌面；CI 已编译 Linux | 需要 WebKitGTK 渲染/剪贴板/IME 实机验收、Preview 原生能力降级说明 |
| B. macOS Intel / Universal 包 | 成本低，覆盖老机器 | 用户量有限 |
| C. 工作区快照 v2（多窗口 + 远程会话恢复） | 配合 v3.2 多窗口 | 需要迁移旧快照（`archive/MIGRATION.md` 模式） |
| D. 自动化接口（本地 socket/CLI，只读查询会话状态） | 让外部脚本/Agent 查询 Tunara 状态，类比 cmux | 必须只读，避免滑向 GOAL 明确不做的“自动写 PTY / orchestration” |

建议：v4.0 选 **A + C**，D 作为只读 CLI 小步试点。

---

## 5. 继续明确不做（与 GOAL.md 保持一致）

IDE 语言服务/调试器、自动 Git 写操作、持久 Agent Timeline/Event Store、Agent orchestration/自动审批、插件市场、云 workspace、遥测、解析 Agent stdout。

---

## 6. 时间线与依赖

```
v3.1 稳态 ──► v3.2 终端本职 ──► v3.3 远程工作台 ──► v4.0 平台
  E2E + SSH 矩阵是后面所有阶段的前置门禁
  SSH 模块拆分 是 v3.3 的前置
  多窗口(v3.2 候选) 是 快照 v2(v4.0) 的前置
```

估算（按 Devin session 吞吐）：v3.1 ≈ 2–3，v3.2 ≈ 2–3（多窗口另计 2），v3.3 ≈ 3，v4.0 ≈ 3–4；外部等待主要是 macOS 签名/公证、Linux 实机验收。

## 7. 已批准的决策（2026-09-25）

1. GPU 渲染：设置提供「自动 / GPU / 兼容」三档，默认「自动」——字形自检通过才启用 WebGL，否则保持 DOM。
2. 多窗口：不并入 v3.2 主线，作为单独立项，与快照 v2（v4.0-C）一起推进。
3. v4.0：做 Linux 正式支持（A）+ 工作区快照 v2（C）；只读本地 CLI（D）小步试点。
4. 多路复用器：tmux / zellij 通过 `MultiplexerAdapter` 与 HerdR 同等级支持。
