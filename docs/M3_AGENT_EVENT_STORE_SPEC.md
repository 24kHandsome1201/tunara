# M3 Agent Event Store 后端底座实施规格

日期：2026-07-13
基线：`d3f47d9c910a07856dd686b44863aece9818c635`

## 唯一目标与用户价值

本切片只建立 Phase 4 / 固定顺序 M3 的本地 Agent Event Store：让后续 Agent Attention 与 Timeline 有一条确定顺序、可重启恢复、可分页、可显式删除且失败不影响真实 PTY 的事实源。Phase 3 的 required screenshot gate 仍未完成；本切片不把 Phase 3 或 Phase 4 整体标记完成。

## Scope / Non-scope

Scope：稳定的 `AgentEventHeaderV1`、独立 private payload、Rust 单写入者 append-only header log、幂等 append、快照游标分页、单 payload 显式读取、重启恢复、精确 workspace/task 删除与全部清空、持久 capability 开关、未知 schema/损坏 fail-safe、10,000 header 确定性 fixture 和本机 optimized/release 证据。

Non-scope：Timeline React UI、虚拟列表、富 Markdown/diff/图片渲染、全文搜索、流式 token 合并 UI、Mobile Companion、Task Journal、Agent 自动启动或协调、任何 PTY 自动写入/执行、Phase 3 截图以及 Phase 5+。

## 依赖与复用点

- 复用 Tauri trusted `main` command allowlist；Preview window 不获得 Event Store 权限。
- 复用 `app_local_data_dir()` 解析正式 app 数据位置，但不复用会吞首次解析错误的 frontend plugin store，也不写入 workspace snapshot。
- 复用现有 `parking_lot`、`serde_json`、`sha2`、`base64`；不引入 SQLite、新服务或网络依赖。
- Event Store 使用独立锁、独立目录、独立错误域，不持有或调用 `PtyState`。IPC 文件操作放到 blocking worker；PTY 输出路径不接入 Event Store。

## 数据模型、磁盘布局与 IPC

正式位置由 status API 返回，release macOS 预期位于 Tauri identifier `dev.tunara.app` 的 app-local-data 下：

```text
agent-events/
  disabled                 # 存在即 capability 关闭；不删除历史
  v1/
    manifest.json          # schemaVersion + delete generation
    headers.jsonl          # 只追加 AgentEventHeaderV1；显式删除时原子重写
    delete.pending.json    # 删除事务恢复记录，仅事务期间存在
    payloads/<event-id>.json
```

`AgentEventHeaderV1` 只包含 `schemaVersion`、Rust 分配的单调 `sequence` / `eventId`、调用方幂等 `clientEventId`、`workspaceId`、`taskId`、可选 `sessionId`、`kind`、`source`、`occurredAtMs`、`recordedAtMs`、安全 `summary` 和 payload 元数据（状态、content type、字节数、SHA-256）。排序只使用 `sequence`，不使用时间或客户端 ID。命令正文、Prompt、PTY scrollback、文件正文、diff、tool output、URL query/fragment、secret 不得进入 header；这些内容只有调用方明确传入 `privatePayload` 时才进入独立 payload 文件。

IPC：

- `agent_event_store_status`：能力状态、schema、数据位置、计数/字节预算、保留/导出/隐私合同。
- `agent_event_append`：校验并持久化，按 `workspaceId + clientEventId` 幂等返回同一 header。
- `agent_event_list`：newest-first 轻量 header 页；默认 100、最大 200；绝不读取 payload。
- `agent_event_payload`：按 event ID 显式读取单个 payload并校验长度/hash。
- `agent_event_delete`：只接受结构化 `workspace`、`task` 或 `all` scope 及 `confirmed: true`，不接受路径、glob 或 prefix。
- `agent_event_store_set_enabled`：持久开关；关闭不删除数据，关闭期间 status 与显式全清理仍可用，其余操作返回可判定错误。

游标是 opaque、版本化并绑定 scope/delete generation，内部保存首次查询的 snapshot high-water mark 和 exclusive `beforeSequence`。并发 append 不进入旧游标快照；显式删除会使旧游标失效，从而保证分页不漏不重且不会跨 scope 复用。

## 严格预算与敏感边界

- 最多 100,000 个 header、private payload 合计最多 256 MiB；达到上限拒绝新 append，不静默删除。
- 单 header JSON 编码最多 8 KiB；单 payload 最多 1 MiB。
- `summary` 最多 512 UTF-8 bytes；`kind/source` 最多 64 bytes；identity/client ID/content type 最多 256 bytes。
- 所有 identifier 拒绝空值、NUL、控制字符、`/`、`\\`、`.` / `..`；summary 只允许单行可显示文本。
- payload 是本机私有数据，不进入日志、header 列表、遥测或后台导出。日志只允许 sequence/count/bytes/error class。

## 错误、取消与恢复

- append 是单条、有界、durable 操作；成功后不可取消，失败不返回虚假成功。分页上限 200，当前切片不增加取消 IPC。
- payload 先写同目录临时文件、sync、原子 rename，再追加并 sync header；header 失败会清理该 payload。启动时只在完整可读 store 内清理 orphan temp/payload。
- 尾部半写 header 可截回最后完整记录并把恢复事实暴露在 status；中段坏行、manifest 损坏、sequence/ID/checksum 不一致进入 `corrupt`，不静默跳过或重编号。
- 未来/未知 schema 进入 `migrationRequired`，不覆盖原数据；本切片不自动迁移旧 schema。用户可先保留目录，或显式 `all` 清理后创建 v1。
- 删除使用 pending journal，可在重启后幂等续做；成功才移除 journal。单 payload hash 损坏只让显式读取返回 `corruptPayload`，不阻断 header 分页。
- 任何初始化失败都转成 Event Store 自身 disabled/degraded state；Tauri setup 继续，真实 PTY 与普通终端不依赖该结果。

## 保留、导出、删除、回滚与清理

- 保留：无自动过期、无隐式 prune；达到数量/字节预算后拒绝写入并由 status 暴露配额。
- 导出：本切片 `supported: false`。未来只能由用户显式选择导出脱敏 header 或选定 payload；不允许后台上传或把本地目录宣称为稳定导出格式。
- 删除：workspace/task 精确删除或 all 清空会物理删除对应 payload，并原子重写剩余 header；关闭 session 不自动删历史。重复删除幂等。
- capability 关闭是首选回滚：停止 append/list/payload，但保留数据；重新开启恢复兼容 v1。代码回滚前可先关闭能力；数据清理由显式 all 清空完成。
- 删除/清理只作用于 resolved `agent-events` 目录；遇 symlink 或目录边界异常 fail closed。

## 预计文件

预计 9–10 个文件，超过 8 个是因为需要同时交付 Rust store、Tauri ACL/注册、typed IPC、规格、状态账本、合同测试与真实基准摘要；不新增服务：

- `src-tauri/src/modules/agent_event_store.rs`
- `src-tauri/src/modules/mod.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/permissions/main.toml`
- `src/modules/agent-events/agent-event-bridge.ts`
- `tests/agent-event-store-contract.test.mjs`
- `docs/M3_AGENT_EVENT_STORE_SPEC.md`
- `docs/benchmarks/m3-agent-event-store-macos-2026-07-13.md`
- `docs/GOAL_STATUS.md`

## 测试、真实性能与资源预算

- Rust 定向测试覆盖：append/幂等/限制、10,000 header 全分页恰好一次且 payload read counter 为 0、页间 append 快照稳定、重启恢复与 sequence 延续、tail recovery、中段损坏/未来 schema、payload hash 损坏、精确删除/重启续删、disabled→enabled、配额与路径边界。
- Node 合同测试覆盖 typed bridge、trusted main ACL、Preview 无权限、无 Timeline React/UI 接入和 payload 只能显式读取。
- 必跑 Node/Rust 全量、两套 typecheck、lint、`cargo fmt --check`、严格 clippy、frontend production build、`git diff --check`。
- 本机用 release Rust harness 真实加载同一 store 后端，生成 10,000 headers，记录 append fixture、首 100 header、全分页、重启、磁盘和 RSS 摘要；同时运行真实 local PTY 输入/回显探针。硬门：分页零 payload read、10,000 sequence 无漏重；首 100 headers p95/单次 < 50ms、全分页 < 500ms、store RSS 增量 < 64MiB、PTY 回显 p95 < 50ms 且零失败。
- 构建真实 optimized/release Tauri bundle；Linux/SSH 只能补充纯 Rust 证据，不能替代 macOS 门。原始 fixture、日志和完整输出只写 temp/ignored/cache。

## 继续、停止与可撤回条件

继续到富 Timeline UI 的必要条件：上述 append/持久化/分页/重启/删除/关闭/损坏门全部通过，本机 10,000 header 与真实 PTY 预算通过，release bundle 成功，且本切片可单独关闭。

任一条件停止：origin/main 离开指定基线且无法确认合法后续；未知产品数据边界；Event Store 初始化或背压进入 PTY 链；分页预读 payload；删除越界/残留却报告成功；迁移覆盖旧数据；macOS release/harness 或完整门禁无法真实证明。停止时保留隔离 worktree 和用户数据，不伪造完成、不提交、不推送。

本计划假设 100,000 headers / 256 MiB 是第一版足够且可撤回的本地预算；若真实 dogfood 超出，先以 status 证据调整预算或引入分段压缩，不把无限增长或静默 prune 带进本切片。
