# M2 SSH 安全写阶段证据（2026-07-12）

## 当前结论

SSH 安全写的生产接线、同进程并发串行、逐阶段故障注入、真实生产 adapter 复测、双独立客户端竞争，以及替换结果未知后的真实 GUI 重连对账均已落地。隔离 bundle 在 `de-netcup` 连续两次通过真实文件点击、Save、`outcomeUnknown`、强制断线、重连、草稿恢复与“确认远端结果”闭环；Phase 2 的 SSH 安全写完成门据此关闭。完整编辑 surface 的本地/SSH 冲突、窄窗与键盘等其余 Phase 2 门仍独立保持未完成。

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
- 替换后连读取也失败时返回 `outcomeUnknown:<attempted-sha256>:<expected-mode>:lockOwner=<owner-sha256>:cleanupPending=<bool>`；前端只接受规范小写 SHA-256、规范八进制 mode、owner 和严格布尔值，保存按钮保持禁用并保留草稿，重连后显式 reconcile command 同时核对内容与 mode，不以“内容碰巧相同”冒充保存成功。

## 自动验证

- SSH safe-write、reconcile、Markdown 与 editor 定向测试通过；沙箱外默认 `pnpm test` 当前包含 538 项 Node（全通过）、5 项真实挂载的 FilePreview 组件测试（全通过）与 168 项 Rust（5 项真实环境测试按条件忽略）。组件门通过 happy-dom、Testing Library 与 Tauri `mockIPC` 驱动真实 React effect/state/event，覆盖正常保存 payload、冲突后 reload、SSH 断连 reload、权限保存失败及 pending 防重复读取；合同不再只由源码正则间接证明。其余合同继续锁定 create-new、二次 fingerprint、flush/mode/sync/shutdown、原子替换、“不得删除目标”、unknown token 严格解析、草稿跨 PTY 重挂载、终端退出清除失效 PTY、SSH 失败原因边界、源码/预览滚动映射、MDX 静态边界和 UI 禁止盲目重试。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：168 通过、5 个真实环境测试按条件忽略；其中 3 个 SFTP live-host 测试均已显式运行通过，严格 clippy 通过。
- 独立 `safe_write` fake transaction matrix 以 10 个表驱动测试覆盖 19 个故障/竞争场景：初读、create、write、flush、set-mode、sync、close、replace-lock 获取/释放、二次读取、replace-not-sent、unsupported、status-lost before/after、reconcile disconnect、cleanup failure、同尺寸内容冲突、symlink swap、mode 不一致与同路径并发。每个确定失败都断言原内容/mode、临时文件与清理状态；锁释放失败必须返回 outcomeUnknown，不能邀请盲目重试。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`：通过。
- `pnpm typecheck`、`pnpm lint`：通过。
- `pnpm build` 生成独立 `FilePreview` chunk 28.03 kB（gzip 8.78 kB）；主 `App` chunk 为 469.64 kB（gzip 127.26 kB），相较静态接线的 487.59 kB 主 chunk 仍减少 17.95 kB。MDX parser、静态源码岛与编辑错误分类留在按需 chunk，不引入 runtime 或执行器。
- M2 产品验收所需的一次性 release-lock 故障控制由非默认 Cargo feature、feature-only inlined plugin manifest 和隔离 capability 三重约束：默认编译图不包含模块或 ACL，主 command handler 不注册该命令；feature 构建只允许存活 SSH session 和 `/tmp/tunara-m2-safe-write-benchmark-*` 单层文件，按 `(ptyId,path)` 一次性消费，不接收 shell、主机、凭证或任意故障阶段。默认 Rust 168 项、feature Rust 170 项及 feature 严格 clippy/格式门此前均通过；Node 源码门进一步锁定非默认 feature、ACL、真实按钮驱动和普通 build 不注入 fixture 路径。

## 隔离 bundle 的真实 GUI 闭环

`scripts/benchmark-m2-safe-write.sh all` 构建独立 identifier/product name 的 release app，并写入只含一个 `de-netcup` SSH session 的隔离 workspace。runner 不调用编辑器内部保存函数：它点击真实文件行，以原生 textarea `input` 事件产生草稿，点击真实 Save；后端只在 replace 已完成后注入一次 release-lock 失败，使产品进入 `outcomeUnknown`。随后 runner 杀死真实 SSH 父进程，观察 exit `-2` 与 `disconnected`，触发产品重连，重新点击文件并检查跨 PTY 草稿/token 恢复，最后点击真实“确认远端结果”。

2026-07-12 连续两轮均以脚本退出码 0 通过；第二轮复用第一轮 bundle，但使用全新 fixture，排除 build nonce 偶合：

- editor：opened、dirty、Save clicked、unknown seen、unknown 时 Save disabled、断线前草稿保留、重连后草稿恢复、reconcile clicked、最终 Saved/clean 全为 true。
- recovery：exit `-2`，writer generation `1 → 2`，最终 phase `ready`；两轮 reconnect 为 3371 ms / 3198 ms。
- independent SSH：最终 SHA-256 均为 `7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919`，mode 均为 `0640`，temp/lock residue 均为 0。
- 原始证据：[首轮 result](./raw/m2-ssh-safe-write-gui-2026-07-12/result.json)、[复跑 result](./raw/m2-ssh-safe-write-gui-2026-07-12/repeat-result.json)。

该运行同时发现并修复一个真实产品回归：`FileExplorer.toggleFile` 把“当前没有 preview，无需脏草稿保护”误当成“禁止打开首个文件”，导致文件行存在但点击无效。新增真实挂载 `FileExplorer → FilePreview` 的组件测试，锁定首个远程文件能打开可编辑 surface。

## 真实外部修改冲突与 Reload

同一隔离 release runner 在 outcomeUnknown 对账 Saved 后继续执行真实冲突路径，不通过 mock 或第二套编辑实现：编辑器输入与当前远端内容同长度的 `mine!\n` 草稿；随后经同一 SSH terminal 把远端替换为同长度 `other\n` 并保持 `0640`，终端 marker 同时证明外部 SHA-256 为 `7e4fa2eb8c7ac089739d5defc4489fad68a100d92082ca35c6b40a4524821f87`。runner 点击真实 Save，等待产品进入 Conflict，确认 `mine!\n` 草稿未被覆盖；再点击真实 Reload，等待 textarea 变为 `other\n`、状态回到 idle 且 Save disabled。

2026-07-12 连续两轮均以退出码 0 通过：Conflict 分别在 1179 ms / 1906 ms 出现，Reload 分别在 1314 ms / 1611 ms 完成。两轮独立 SSH 最终均确认 `other\n` SHA-256、mode `0640` 与 0 个 temp/lock 残留。原始证据：[首轮](./raw/m2-ssh-conflict-reload-gui-2026-07-12/result.json)、[复跑](./raw/m2-ssh-conflict-reload-gui-2026-07-12/repeat-result.json)。

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

- 本地编辑 surface 的真实保存重开、外部修改冲突、原生窗口关闭草稿门，以及 Markdown 窄窗/语言/纯键盘和首 PTY 性能门；SSH outcomeUnknown、同尺寸外部修改 Conflict 与 Reload 已关闭，不把它扩大声称为全部 Phase 2 验收。
