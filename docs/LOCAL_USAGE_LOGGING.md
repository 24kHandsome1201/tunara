# Local usage logging / 本地使用日志

## English

Tunara can write an **opt-in, local-only** diagnostic event log for SSH
workflows. It is disabled by default. Enable it under **Settings → App → Local
usage logs**; the same switch stops new writes immediately.

Tunara never uploads these logs. The only sharing path is the **Export JSONL
bundle** button, which creates a file at a location chosen by the user. Review
that file before sending it to anyone.

### Privacy boundary

The native Rust writer accepts a fixed event and attribute allowlist. Unknown
event names and attributes are rejected before disk I/O. The log never contains:

- passwords, private keys, passphrases, tokens, or other credentials;
- clipboard data, terminal input/output, file contents, or raw command text;
- hostnames, usernames, IP addresses, or filesystem paths.

Authentication is recorded only as a category (`agent`, `key`, `password`,
`keyboard_interactive`, or `unknown`). Operations, sizes, outcomes, and errors
are similarly reduced to bounded categories. Session and correlation values are
SHA-256-derived anonymous IDs using a fresh random salt for each app run. They
can correlate related events within one run but cannot be linked across runs.

### JSONL schema (version 1)

Each complete line is one JSON object:

```json
{"schema_version":1,"app_version":"2.0.0","timestamp_ms":1786700000000,"app_run_id":"6d51…","event":"ssh.session.opened","session_id":"anon_4bf2…","correlation_id":"anon_77a9…","duration_ms":684,"success":true,"outcome":"completed","attributes":{"auth_method":"key","route":"direct"}}
```

Required fields are `schema_version`, `app_version`, `timestamp_ms`,
`app_run_id`, and `event`. Depending on the event, optional fields are
`session_id`, `correlation_id`, `duration_ms`, `success`, `outcome`,
`error_category`, and `attributes`. `duration_ms` on a connection phase is the
elapsed time since the preceding phase.

The version 1 catalog covers app start; SSH session create/open/close;
connection phases; host-key prompt, decision, and persistence; authentication
category; reconnect/disconnect; high-level terminal command start/finish;
remote Files operations; Transfers and recovery; and Preview/tunnel actions.
Command text, terminal bytes, paths, remote identities, and file data are not
part of the schema.

### Storage and failure behavior

- JSONL files rotate at 2 MiB.
- The directory is capped at 20 MiB total and old files expire after 7 days.
- On Unix, the directory is mode `0700` and files are mode `0600`.
- Writes, cleanup, and rotation are serialized across windows and sessions.
- A new app run uses a new file identity. If a crash leaves a partial final
  line, export skips that line and keeps all complete valid JSON records.
- Path, randomness, permission, full-disk, and other write failures are
  best-effort failures: they do not interrupt SSH, terminal, transfer, or app
  startup flows.
- **Clear logs** removes only Tunara-managed usage-log files. **Open log
  directory**, export, or clear can report unavailable on unsupported native
  platforms.

The export is a consolidated JSONL file, not a ZIP archive. Because sensitive
payloads are intentionally absent and anonymous IDs reset on every app run,
the log supports workflow timing and failure analysis rather than command or
terminal-content reconstruction.

## 中文

Tunara 提供一个**明确选择开启、仅保存在本机**的 SSH 工作流诊断日志。
该功能默认关闭；可在 **Settings → App → 本地使用日志** 中开启，同一开关
关闭后会立即停止新的写入。

Tunara 绝不上传这些日志。唯一的分享路径是用户主动点击**导出 JSONL 日志
包**，并自行选择保存位置。发送给他人前仍建议先检查导出的文件。

### 隐私边界

原生 Rust 写入层只接受固定的事件名和属性白名单；未知事件和属性会在落盘
前被拒绝。日志绝不包含：

- 密码、私钥、passphrase、token 或其他凭据；
- 剪贴板内容、终端原始输入/输出、文件内容或原始命令文本；
- 主机名、用户名、IP 地址或文件路径。

认证方式只记录为 `agent`、`key`、`password`、`keyboard_interactive` 或
`unknown` 分类；操作、大小、结果和错误也只保留有限分类。session 与
correlation 值会使用每次应用启动新生成的随机盐进行 SHA-256 不可逆匿名化：
同一次运行内可以关联，跨运行不可关联。

### JSONL schema（版本 1）

每个完整行都是一个 JSON 对象。必有字段为 `schema_version`、
`app_version`、`timestamp_ms`、`app_run_id` 和 `event`；按事件可包含
`session_id`、`correlation_id`、`duration_ms`、`success`、`outcome`、
`error_category` 和 `attributes`。连接阶段事件的 `duration_ms` 表示距离
上一个阶段经过的时间。

版本 1 覆盖：应用启动、SSH session 新建/打开/关闭、连接阶段、host-key
提示/选择/持久化、认证类别、重连/断线、终端命令开始/结束的高层状态、远程
Files、Transfers 与恢复，以及 Preview/tunnel 动作。原始命令、终端字节、
路径、远端身份和文件数据不属于该 schema。

### 保存、轮转与失败行为

- 单个 JSONL 文件达到 2 MiB 后轮转；目录总量上限为 20 MiB；保留 7 天。
- Unix 下目录权限为 `0700`，文件权限为 `0600`。
- 多窗口、多 session 的写入、清理和轮转由同一个原生互斥边界串行化。
- 每次冷启动使用新的文件身份；若崩溃留下不完整末行，导出时会跳过该末行，
  只保留完整有效的 JSON 记录。
- 路径、随机源、权限、磁盘空间等失败均按 best-effort 处理，不会中断 SSH、
  终端、传输或应用启动主流程。
- **清除日志**只删除 Tunara 管理的使用日志；不支持的原生平台会对打开目录、
  导出或清除操作给出不可用反馈。

当前导出格式是汇总后的 JSONL，而不是 ZIP。由于敏感载荷被主动排除，且匿名
ID 每次启动都会重置，这些日志适合分析工作流阶段、耗时和失败分类，不适合也
不能用来还原命令或终端内容。
