# M2 SSH 安全写阶段证据（2026-07-12）

## 当前结论

SSH 安全写的生产接线、同进程并发串行、逐阶段故障注入、真实生产 adapter 复测和替换结果未知的前后端对账入口已经落地。真实断线后的 UI 重试、双进程竞争与完整编辑 surface 产品验收仍未完成，因此本报告不关闭 Phase 2 SSH 完成门。

## 已实现合同

- 远端读取先使用 `lstat`；只有完整、非截断、UTF-8、≤256 KiB 的普通文件返回 SHA-256 fingerprint，symlink 不获得可编辑凭据。
- 保存要求绝对、无父级穿越、无换行/NUL 的 UTF-8 路径，以及规范的 64 位小写 SHA-256 expected fingerprint。
- 临时文件位于目标同目录，使用 SFTP `WRITE | CREATE | EXCLUDE` 创建；写入后 drain write ACK、恢复原 mode、请求 sync 并关闭 handle。
- 最终替换前重新完整读取目标并比较 SHA-256；冲突返回结构化 `Conflict`，不覆盖外部修改。
- `russh-sftp 2.3.0` 未暴露 `posix-rename@openssh.com`。当前在同一 SSH 连接的独立 exec channel 上，对逐参数 shell-quoted 的同目录路径执行 `mv -f --`；不使用 `remove(target) + rename(temp)`。
- 替换后重新读取并核对内容与 mode；所有已知失败路径 best-effort 删除临时文件。
- 同一 session/path 的应用内保存由弱引用异步锁串行化；锁表只保留活动路径，不随历史路径永久增长。
- 临时文件准备完成后，客户端以目标完整路径 SHA-256 派生固定长度同目录隐藏 lock dir，并用 SFTP 原子 `mkdir` 获取跨进程替换锁；二次 fingerprint 检查与 rename 都位于该短临界区。竞争客户端等待持有者释放后重新检查，不能同时以同一个旧 fingerprint 保存。锁超过 10 分钟才允许回收，正常路径与失败路径都显式 `rmdir`；锁释放失败降级为可对账的 outcomeUnknown，不邀请盲目重试。
- 替换请求返回失败时先读取目标对账。内容和 mode 都匹配才判定已保存；目标仍是旧 fingerprint 时判定未替换；第三方内容或权限变化返回冲突。
- 替换后连读取也失败时返回带 `cleanupPending` 的 `outcomeUnknown:<attempted-sha256>:<expected-mode>:cleanupPending=<bool>`；前端只接受规范小写 SHA-256、规范八进制 mode 和严格布尔值，保存按钮保持禁用并保留草稿，重连后显式 reconcile command 同时核对内容与 mode，不以“内容碰巧相同”冒充保存成功。

## 自动验证

- SSH safe-write、reconcile、Markdown 与 editor 定向 Node：15/15 通过；完整 Node 520 通过、3 skipped。合同锁定本地与 SSH 接线、create-new、二次 fingerprint、flush/mode/sync/shutdown、原子替换、“不得删除目标”、unknown token 严格解析以及 UI 禁止盲目重试。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：168 通过、5 个真实环境测试按条件忽略；其中 3 个 SFTP live-host 测试均已显式运行通过，严格 clippy 通过。
- 独立 `safe_write` fake transaction matrix 以 10 个表驱动测试覆盖 19 个故障/竞争场景：初读、create、write、flush、set-mode、sync、close、replace-lock 获取/释放、二次读取、replace-not-sent、unsupported、status-lost before/after、reconcile disconnect、cleanup failure、同尺寸内容冲突、symlink swap、mode 不一致与同路径并发。每个确定失败都断言原内容/mode、临时文件与清理状态；锁释放失败必须返回 outcomeUnknown，不能邀请盲目重试。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`：通过。
- `pnpm typecheck`、`pnpm lint`：通过。

## `de-netcup` 隔离夹具

夹具位于 `/tmp/tunara-phase2-ssh-write-smoke`，结束后已清理。输入文件名含中文与空格，初始 mode 为 `0640`。

结果：

- 初始 SHA-256：`9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb`
- 替换后 SHA-256：`7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919`
- 替换后内容：`after`
- 替换后 mode：`640`
- `.tunara-*.tmp` 残留：无

该 smoke 证明目标 Unix/OpenSSH 主机的同目录 `mv`、权限和特殊路径语义，不冒充 Tunara IPC/UI 产品链证据。

## 生产 adapter live-host 复测

新增默认 ignored 的 `real_ssh_safe_write_adapter_preserves_content_mode_and_conflicts`，通过 `SshSession::open` 和真实 `SftpWriteAdapter` 在 `de-netcup` `/tmp` 创建唯一隔离目录，不复制一份测试实现。2026-07-12 实际执行通过：

- 中文空格目标由 `before\n` 保存为 `after\n`，mode 保持 `0640`。
- 独立 exec channel 同尺寸改写为 `other\n` 后，旧 fingerprint 保存返回结构化冲突，目标内容与 mode 未被破坏。
- `.tunara-*.tmp` 残留为空，测试目录清理完成。
- 当前源码 Debug app 同期真实启动并恢复 `de-netcup` SSH session；ScreenshotDaemon 对窗口仍只返回壁纸，Computer Use 无法识别开发 bundle id，因此不把这次启动冒充文件行点击或像素级 UI 证据。

## 双独立客户端竞争

新增默认 ignored 的 `real_ssh_independent_clients_allow_at_most_one_stale_fingerprint_save`，并行建立两条独立 `SshSession` 与两个 SFTP subsystem，不共享 Tunara 进程内 path mutex。`de-netcup` 上连续 12 轮对同一 baseline fingerprint 并发保存，每轮严格得到 1 个 Saved 与 1 个 Conflict；目标 mode 保持 `0640`，所有 `.tmp` 与 lock dir 均在临界区后释放，隔离目录最终清理。该测试验证的是生产远端锁与真实网络时序，不以单进程序列化冒充跨客户端安全。

## 真实替换后状态丢失

新增默认 ignored 的 `real_ssh_replace_status_loss_reconciles_saved_on_a_fresh_connection`。测试使用一次性本地 TCP proxy 转发真实加密 SSH，生产 `SftpWriteAdapter` 仍执行相同的 shell-quoted `mv -f --`；仅测试编译增加实例级 request-accepted 探针和 3 秒响应延迟。探针确认 exec request 已被服务端接受后暂停 server→client 响应，第二条独立直连 SSH/SFTP 轮询并证明目标已变为 `after\n`、mode 仍为 `0640`，随后关闭 proxy 两端 socket，使原连接收不到 exit status。

结果：原事务返回 `OutcomeUnknown { expected_mode: 0640, replace_lock_owner, cleanup_pending: true }`；新连接调用从 Tauri command 抽出的同一 `reconcile_text_write_with_sftp` 生产核心，得到 Saved。lock owner 是本次临时路径的 SHA-256，不暴露路径本身；前端 token 对它执行与 fingerprint 相同的规范校验。对账前测试明确看到专属 temp/lock residue，对账后生产核心仅删除 owner hash 匹配的临时文件及 owner marker 匹配的 lock，残留归零。随后人为放入另一个 owner 的 lock，再次用旧 token 对账必须失败且异主 lock 保持，最终才清理随机 `/tmp/tunara-m2-status-loss-*` 夹具。该证据关闭“真实 replace 已执行但状态丢失”和 owner-scoped 自动清理的后端门，不冒充 GUI 重连点击闭环。

## 尚未关闭

- GUI 重连后实际点击“确认远端结果”，展示 Saved/Conflict 并解除 unknown 状态。
- Tunara 编辑 surface 经真实 SSH 会话保存、外部同尺寸修改冲突和重新加载。
