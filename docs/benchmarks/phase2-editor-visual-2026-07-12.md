# Phase 2 编辑器视觉与键盘验收，2026-07-12

## 结论

生产 `FilePreview` 与全局样式通过独立视觉 harness 真实渲染。窄 Inspector 的长中文文件名不再把模式切换或关闭动作挤出可视区域；冲突说明在窄面板中展示全文，不再截断关键恢复信息。中英文、SSH/本地、干净态/冲突态和规格要求的 640×480 固定窗口均有像素证据。

## 覆盖

- 396px 编辑器容器：中文 SSH 干净态，身份行与操作行分层，编辑、预览、关闭和保存均可见。
- 395px 编辑器容器：中文 SSH 与英文 SSH 冲突态，冲突正文完整显示，复制草稿与重新载入动作均可见。
- 640×480 浏览器窗口：中文 SSH 干净态与英文本地冲突态；编辑器容器固定 395px，稳定触发与真实 Inspector 相同的 container query。
- 700px 宽窗：英文本地干净态保持单行 header，未被窄窗规则污染。
- 纯键盘组件门：Edit/Preview 使用 roving tabindex；ArrowRight、Home 完成切换并迁移焦点；重新进入编辑态后 Ctrl+S 经过真实保存 handler，测试通过。

## 修复

- `≤460px` 时 header 使用单列 grid，文件身份与操作分成两行；操作行占满容器并在模式切换与关闭之间保留稳定空间。
- 安全 alert 继续纵向重排，但不再使用三行 line clamp，避免隐藏冲突、断线或 outcome-unknown 的关键说明。
- `≤420px` 时行号 gutter 从 46px 收敛至 38px，源码内边距从 16px 收敛至 12px，正文获得更多有效宽度而不改变横向滚动语义。

## 原始证据

- [中文 SSH 干净态，396px](./raw/phase2-editor-visual-2026-07-12/zh-clean-396.png)
- [中文 SSH 冲突态，395px](./raw/phase2-editor-visual-2026-07-12/zh-conflict-395.png)
- [英文 SSH 冲突态，395px](./raw/phase2-editor-visual-2026-07-12/en-conflict-395.png)
- [中文 SSH 干净态，640×480](./raw/phase2-editor-visual-2026-07-12/zh-clean-640x480.png)
- [英文本地冲突态，640×480](./raw/phase2-editor-visual-2026-07-12/en-conflict-640x480.png)

## 边界

这组证据关闭 Markdown/MDX 的窄窗、中英文、冲突可读性与纯键盘门；它不代替本地真实文件保存重开、原生窗口关闭草稿门或首 PTY 冷启动性能门，这三项继续保持未完成。
