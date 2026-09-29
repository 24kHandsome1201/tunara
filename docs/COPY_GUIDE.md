# Tunara 文案规范 / Copy Guide

适用于 `src/modules/i18n/locales/{en,zh-CN}.json` 中的用户可见文案。新增或修改文案时遵守本规范，`node scripts/i18n-audit.mjs` 会校验键引用与重复值。

## 术语表（zh-CN 与 en 对照）

| en | zh-CN | 说明 |
| --- | --- | --- |
| terminal | 终端 | 一次终端会话的用户可见名称统一用“终端”。`session` 译作“会话”仅保留在恢复/历史语境（如 `app.splash.restoring`、`ssh.postConnectCommandHint`）；`SSH session` 译“SSH 连接”。 |
| host | 主机 | 不使用“服务器 / server”指代 SSH 主机。 |
| reconnect | 重新连接 | 不使用“重连”。 |
| keyboard shortcut | 快捷键 | 不使用“热键”。 |
| inspector | 检查面板 | 右侧辅助面板的唯一名称；en 用 "inspector"，zh 用“检查面板”，不再使用 panel/面板混称。 |

## English 规则

- Sentence case：仅首词与专有名词大写（"New terminal"、"Open releases"）。
- 进行中的渐进状态以单个 U+2026 省略号结尾（"Connecting…"、"Opening settings…"），不要写 "..."。
- 多句描述以句号结尾；标签、按钮、标题不加句号。
- 不使用全大写强调（写 "not"，不写 "NOT"）。
- 复数不拼分支，用“名词 · {{count}}”或“{{count}} 行/条”格式（i18n 无复数规则）。

## 错误 Toast（F-14 规范）

`src/ui/lib/error-toast.ts` 的 `errorToast()` 是错误提示的唯一入口：

- `title`：什么操作失败了（"Open in editor failed"）。
- `subtitle`（`next`）：下一步该做什么，或一句发生了什么（"Choose an editor in Settings → Terminal, then try again."）。
- `error`：原始错误信息，进入 `errorDetail`，由复制按钮带出，不进 subtitle。

共用的通用动作键放在 `common.*`（retry/close/cancel/back/done/reconnect/settings/preview/host/copy_failed 等），不要新建同义键；audit 会对 ≥3 个同值键告警。
