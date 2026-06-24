# Tunara 当前分支审查与修复记录

日期: 2026-06-21
分支: `fix/tunara-fixes-2026-06-21`

## 当前口径

这份记录只描述当前仓库分支里的真实改动和本机验证结果。旧的外部目录补丁来自 `/mnt/data/tunara_original` 到 `/mnt/data/tunara_review_work` 的 `diff -ruN`, 不是本仓库生成的 git patch, 已从源码分支移除。

更完整的问题清单和 GPT Pro review 校准见:

- `review/current-review-2026-06-21.md`
- `review/code-review-2026-06-21.md`
- `review/design-review.md`

其中 `code-review-2026-06-21.md` 和 `design-review.md` 是外部环境输入, 当前分支结论以 `current-review-2026-06-21.md` 和实际命令输出为准。

## 合入判断

当前分支可以保留的方向:

- 设置值 sanitize 和 clamp。
- 终端主题 light variants。
- 终端搜索结果计数。
- 分屏中 active session 可见性保障。
- MainArea 切换目录时清空 stale remote state。
- 命令面板增加常用动作。

仍需优先修复的方向:

- 重命名 Escape 必须退出全局 rename 状态。
- 暗色首屏 accent fallback 必须和 React 默认值一致。
- 外部编辑器路径必须展开 `~`。
- PTY write Promise 必须处理失败。
- Agent 状态条不能遮挡终端内容。
- unread 状态不能和关闭按钮抢位。
- Agent 色彩必须统一走 token。
- CLI 设置页需要展示 missing/error/source, 不只展示已安装项。
- 右键菜单要有基础键盘可访问性。
- 右键菜单不应把 "启动所有 Agent" 固化成默认入口。

## 验证门槛

合入前至少需要通过:

```bash
git status --short --branch -uall
git diff --check main..HEAD
pnpm build
pnpm test
```

桌面端 UI 还需要一次真实 Tauri 窗口 smoke。源码测试通过不能替代终端、分屏、设置页、右键菜单和窄窗口 overlay 的真实窗口验证。
