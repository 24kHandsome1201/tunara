# M2 本地文件安全写 Linux 完整性证据（2026-07-12）

## 结论

指定基线 `f7fb1d157a02b74eed148fca3177daaf77a6e921` 上，本地文件安全写内核已在真实 Netcup Debian 12 / ext4 文件系统形成可重复闭环：保存后重新打开得到新内容与新 fingerprint；同尺寸外部修改返回 Conflict 且不覆盖外部内容；非 root 真实权限失败不修改原文件；连续原子替换期间的并发读取只观察到完整旧版本或完整新版本；所有场景保持 mode `0640`，临时文件残留为 0。

这份证据只关闭 Linux 可证明的本地文件内核门，不代表 macOS Tauri WebView、原生窗口关闭、macOS 打包签名或首 PTY 性能已经完成。

## 环境与基线

- 本地 `main` 与刷新后的 `origin/main` 均为 `f7fb1d157a02b74eed148fca3177daaf77a6e921`，执行前工作区干净。
- 远端：`codex-netcup` / `de-netcup`，Debian GNU/Linux 12，Linux `6.1.0-42-amd64`，x86_64。
- 文件系统：`/tmp` 位于 ext4；根分区约 721 GiB 可用，执行前约 18 GiB 内存可用。
- 专用 checkout：`/root/tunara-linux-safe-write-20260712`。远端原本不存在 Tunara 仓库，因此从官方 `https://github.com/24kHandsome1201/tunara.git` 克隆到全新目录并 detached checkout 指定基线；未覆盖任何已有目录。
- 远端补齐 Rust `1.97.0`、pnpm `9.15.4` 与 Debian Tauri/WebKit 编译依赖；仓库依赖使用锁文件安装。

## 验证设计

独立 runner 为 `scripts/benchmark-m2-local-safe-write-linux.sh`，直接执行生产 `fs_read_file` / `fs_write_text_file`，不复制另一套写入实现。

1. 中文与空格文件名的真实 fixture 先读取 fingerprint，保存 `before\n → after!\n`，随后重新打开并核对新内容与新 fingerprint。
2. 外部写入与已保存内容同为 7 字节的 `other!\n`，再用旧 fingerprint 保存 `mine!!\n`；必须返回结构化 Conflict，目标仍为 `other!\n`。
3. 将父目录改为 `0500`，把已编译的同一 Rust 测试二进制交给 `nobody` 执行；临时文件创建必须真实失败，原文件 `original\n` 与 mode `0640` 不变。
4. 两个 64 KiB 完整 payload 交替原子替换 500 轮，同时独立线程连续读取；任何空文件、部分写入或混合内容都使门失败。
5. 每条路径都检查 mode 与同目录 `.tunara-*.tmp` 残留。

## 结果

原始基线定向 Rust 测试先通过 5/5。新增 Node 合同定向测试通过 2/2，新增真实保存/重开/冲突 fixture 通过 1/1。

最终独立 runner 连续两轮均通过：

| 轮次 | 保存重开 | 同尺寸冲突 | 非 root 失败保原文 | 压力轮数 | 并发完整读取 | 部分内容 | mode | 临时残留 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 首轮 | 通过 | 通过 | 通过 | 500 | 702,593 | 0 | `0640` | 0 |
| 复跑 | 通过 | 通过 | 通过 | 500 | 727,551 | 0 | `0640` | 0 |

原始证据：[首轮](./raw/m2-local-safe-write-linux-2026-07-12/result.json)、[复跑](./raw/m2-local-safe-write-linux-2026-07-12/repeat-result.json)。

## 全量门禁

在同一 Netcup checkout、同一源码改动上执行：

- `pnpm test`：通过。Node 542 项中 541 通过、1 项环境条件跳过；UI 8/8 通过；Rust 169 通过、6 项真实环境测试按条件忽略。
- `pnpm build`：通过；Vite production build 完成 259 个模块转换。
- `pnpm lint`：通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `git diff --check`：通过。

最终 rustfmt 机械换行同步后，Node 本批合同定向 2/2 与真实保存/重开/冲突 Rust fixture 1/1 再次通过。

## 明确保留未完成

- macOS Tauri WebView 中真实点击本地文件、编辑、保存、跨文件/会话重开与草稿生命周期。
- macOS 原生窗口关闭及未保存草稿门。
- macOS 打包、Developer ID 签名、公证、Gatekeeper 与 updater 资产。
- macOS 首 PTY 冷启动性能。

Linux 结果不得用于关闭以上门，也不冒充 macOS GUI 或发布链证据。
