# M2 macOS 本地安全写与草稿生命周期验收

日期：2026-07-13（Asia/Shanghai）  
基线：`9255619f315c2ed2ee349d3a149d74aa5d8ec5ef`  
产品路径：隔离的 optimized release Tauri app，真实 macOS WebView、真实本地 PTY 与 `/private/tmp` 文件系统。

## 结论

本地跨文件/跨会话保存重开、fingerprint 更新、同尺寸外部修改冲突、失败不破坏原文件，以及 clean/dirty draft registry 生命周期全部通过。原生窗口关闭草稿门与首 PTY 冷启动性能不在本次范围，仍保持未完成。

## 真实 GUI 流程

隔离 bundle 使用两个恢复的本地会话和三个真实 Markdown 文件。WebView 内实际点击文件行、Save、编辑器关闭按钮与会话 tab；外部修改和权限故障通过同一应用内真实本地 PTY 执行，不使用 Tauri IPC mock。

1. 打开 `first.md`，编辑为 `saved\n` 并点击 Save；保存状态成功且 Save 回到 disabled。
2. 关闭编辑器，打开同目录 `second.md`；再切换到第二个本地会话并打开 `other.md`，内容均正确。
3. 切回首会话重开 `first.md`，读到 `saved\n` 且为 clean，证明保存返回的新 fingerprint 已成为重开基线。
4. 将草稿改为同为 6 字节的 `mine!\n`，真实 PTY 同尺寸改写磁盘为 `other\n`；点击 Save 得到 Conflict，textarea 草稿不丢失。
5. Conflict/dirty 状态点击另一会话 tab，切换被 dirty guard 阻止；点击取消后仍停留原会话且草稿保持。
6. 点击 Reload 回到 `other\n` 并变 clean；关闭后由 PTY 改写为 `third\n`，重新打开读到 `third\n`，证明 clean registry 已删除而非回放旧快照。
7. 将目录权限改为 `0500` 后编辑为 `draft\n` 并保存，UI 进入 error；草稿保留。恢复目录权限后由真实 PTY 读回原文件仍为 `third\n`。

## 结果

- `saveReopen`：5/5 true。
- `conflict`：Conflict 可见、草稿保留；外部改写到 UI 冲突耗时 18 ms。
- `draftLifecycle`：dirty 切换阻止、取消后草稿保留、clean registry 释放均为 true。
- `failure`：error 可见、草稿保留、原文件保留均为 true。
- 首文件打开：107 ms（仅记录，不作为本批首 PTY 冷启动门）。
- 应用外独立检查：最终内容 `third`，同目录 `*.tunara-*.tmp` 残留 0。

原始结果：[result.json](./raw/m2-local-safe-write-macos-2026-07-13/result.json)。

## Harness 回归

首轮产品保存已成功，但 harness 在第二文件等待超时：macOS 本地 PTY 将 `/tmp` 规范化为 `/private/tmp`，严格 `data-file-path` 匹配仍使用旧别名。runner 现于写入 workspace snapshot 前用 `pwd -P` 固定两个 fixture 根路径，并有合同测试锁定；产品路径语义未改变。修复后完整流程一次通过。
