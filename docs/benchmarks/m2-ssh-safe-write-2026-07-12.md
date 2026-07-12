# M2 SSH 安全写阶段证据（2026-07-12）

## 当前结论

SSH 安全写的生产接线、同进程并发串行和替换结果未知对账内核已经落地，但逐阶段故障注入与产品 UI 闭环尚未完成，因此本报告不关闭 Phase 2 SSH 完成门。

## 已实现合同

- 远端读取先使用 `lstat`；只有完整、非截断、UTF-8、≤256 KiB 的普通文件返回 SHA-256 fingerprint，symlink 不获得可编辑凭据。
- 保存要求绝对、无父级穿越、无换行/NUL 的 UTF-8 路径，以及规范的 64 位小写 SHA-256 expected fingerprint。
- 临时文件位于目标同目录，使用 SFTP `WRITE | CREATE | EXCLUDE` 创建；写入后 drain write ACK、恢复原 mode、请求 sync 并关闭 handle。
- 最终替换前重新完整读取目标并比较 SHA-256；冲突返回结构化 `Conflict`，不覆盖外部修改。
- `russh-sftp 2.3.0` 未暴露 `posix-rename@openssh.com`。当前在同一 SSH 连接的独立 exec channel 上，对逐参数 shell-quoted 的同目录路径执行 `mv -f --`；不使用 `remove(target) + rename(temp)`。
- 替换后重新读取并核对内容与 mode；所有已知失败路径 best-effort 删除临时文件。
- 同一 session/path 的应用内保存由弱引用异步锁串行化；锁表只保留活动路径，不随历史路径永久增长。
- 替换请求返回失败时先读取目标对账。内容和 mode 都匹配才判定已保存；目标仍是旧 fingerprint 时判定未替换；第三方内容或权限变化返回冲突。
- 替换后连读取也失败时返回 `outcomeUnknown:<attempted-sha256>:<expected-mode>`；重连后的显式 reconcile command 同时核对内容与 mode，不以“内容碰巧相同”冒充保存成功。

## 自动验证

- `node --test tests/phase2-safe-write-contract.test.mjs`：2/2 通过，锁定本地与 SSH 接线、create-new、二次 fingerprint、flush/mode/sync/shutdown、原子替换和“不得删除目标”负合同。
- `cargo test --manifest-path src-tauri/Cargo.toml`：166/166 通过，2 个需要真实 SSH 环境的测试按条件忽略。
- 独立 `safe_write` fake transaction matrix 以 9 个表驱动测试覆盖 17 个故障/竞争场景：初读、create、write、flush、set-mode、sync、close、二次读取、replace-not-sent、unsupported、status-lost before/after、reconcile disconnect、cleanup failure、同尺寸内容冲突、symlink swap、mode 不一致与同路径并发。每个确定失败都断言目标内容和 mode 未变、临时文件状态与 cleanup 次数。
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

## 尚未关闭

- 替换请求发出后真实断线的 `outcomeUnknown` 与重连产品链对账。
- 两个独立 Tunara 客户端或进程竞争时最多一个成功的证明。
- 本次真实 SFTP adapter 抽取后的 live-host 保存复测。
- Tunara 编辑 surface 经真实 SSH 会话保存、外部同尺寸修改冲突和重新加载。
