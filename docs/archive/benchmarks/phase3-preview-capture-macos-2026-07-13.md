# Phase 3 Preview 来源绑定截图与安全送回：macOS optimized 验收

## 结论

用户触发的 Preview 截图、最小脱敏来源 metadata 与对应真实 PTY 安全送回门禁已关闭。隔离 identifier 的 optimized macOS Tauri 应用使用两个 worktree、两个 loopback fixture 与两条真实 physical PTY，证明 PNG 只包含完整来源键和当前 window generation 对应的 WKWebView 内容；Send 只填入绑定 PTY 且未执行。Phase 3 required gates 至此全部满足，本批停止，不自动进入 Phase 4/5。

## 安全与存储合同

- 截图动作只在可信 main Inspector，由用户显式触发；不可信 Preview capability 保持窄 telemetry ingest，不能截图、录屏、调用 PTY 或获得 app/plugin 高权限。
- macOS 使用 `WKWebView.takeSnapshot`，按原生 safe area 裁切页面内容；不以整屏、主窗口或辅助技术文本替代。只接受 PNG，拒绝非法/不支持格式、零尺寸、超过 16,777,216 像素或 32 MiB 编码上限的结果。
- 原始 PNG/metadata 只写入 app cache 的 `preview-evidence`；文件名为随机 capture id，不含用户名、绝对路径、session id、token、Cookie、URL 凭据或页面 secret。安全本地引用使用 `$HOME` 别名。
- metadata 仅含脱敏 repository/worktree 摘要，workspace/session/terminal/source URL 的 SHA-256 引用，安全 origin，捕获时间、页面 CSS viewport、zoom、window generation，以及 PNG 格式、像素、字节数和 SHA-256。
- Send 在 Rust 侧再次核对 capture 的来源 label、window generation、当前 URL 与 logical-to-physical PTY 映射，只写安全单行引用；不发送二进制/base64，不附加 CR/LF，不执行，也不把系统剪贴板成功当作送达证据。

## optimized macOS 实机矩阵

| 来源/动作 | 页面 CSS viewport / zoom | PNG 像素 | 结果 |
|---|---:|---:|---|
| worktree A 首次捕获 | 312×675 / 125% | 780×1688 | SHA-256 与文件一致；只含 A/41931 页面 |
| worktree B 捕获 | 853×1137 / 90% | 1536×2048 | SHA-256 与文件一致；只含 B/41932 页面 |
| A 关闭重开捕获 | 980×720 / 100% | 1960×1440 | 新 generation；只含重开的 A 页面 |

fixture 同时报告 `devicePixelRatio=2`。A、B 与重开 A 的 PNG 尺寸分别由 CSS viewport × zoom × DPR 解释，边界仅有原生像素取整。三张原图以原始分辨率人工检查，均不含 Preview titlebar、main、PTY、另一 Preview、桌面或其他应用。

| 场景 | 结果 |
|---|---|
| viewport safe area | 390×844 与 768×1024 请求均由真实页面精确报告；outer 高度另含 32px 原生 chrome，不进入截图 |
| 来源 metadata | 两端 origin、脱敏来源摘要、window generation、viewport/zoom、像素/字节/SHA-256 与真实文件交叉一致 |
| PTY Send | A/B 各自只进入对应 physical PTY 输入区；另一 PTY不变，未附加回车、未产生执行输出 |
| 来源隔离 | 跨来源 capture/send 拒绝；两 worktree 不共享记录或窗口 |
| 生命周期 | 已关闭来源拒绝；A 重开 generation 从 1 变为 3，旧 capture 引用拒绝，不复用旧窗口 |
| fail closed | stale、terminal exit、窗口缺失、generation/URL/viewport/zoom 变化、非法/过大/不支持格式均有自动门覆盖 |
| UI 与回归 | 中英文 Capture/Copy/Send 组件门和窄宽度布局通过；真实 390px Preview 矩阵通过，既有 navigation/history/zoom/viewport/lifecycle/ACL/popup/download 保持 |

原始 fixture JSONL、应用日志、截图、metadata 与完整命令输出仅保留在 ignored/cache/temp 中，并在验收后清理。Git 只收录本文和脱敏结构化汇总。

## 自动门禁

- Node、UI 与 Rust 覆盖成功截图/metadata、格式和大小边界、来源/window generation/双 worktree 隔离、关闭/stale/terminal-exit，以及 Copy/Send 只写对应 PTY且不执行。
- 两套 TypeScript typecheck、lint、`cargo fmt --check`、严格 clippy、production frontend build 与 optimized macOS 隔离应用构建均作为本批关闭门重新执行。

## Phase 3 状态

截图 required gate 已满足；Phase 3 正式完成。console/network、服务重启和 SSH tunnel 的既有合同不回归，本批不扩展通用截图管理、远程同步或 Phase 4/5。
