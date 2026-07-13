# M3 Agent Event Store macOS 后端与 PTY 隔离证据

日期：2026-07-13
源码基线：`d3f47d9c910a07856dd686b44863aece9818c635` + 本切片未提交改动
机器：MacBook Air (Mac14,2)，Apple M2 8-core，16 GB，arm64
系统：macOS 26.1 (25B5072a)
构建：Cargo `release` optimized harness；Tauri production `.app` bundle

## 目标与边界

本报告只证明 M3 第一切片的 Rust Agent Event Store 后端：10,000 个轻量 header 的持久加载/分页不读取 private payload，分页无漏重，重启恢复有界，并且 Event Store 分页压力不进入真实 local PTY 的输入/回显链。它不证明 Timeline React UI、虚拟列表、Markdown/diff/图片渲染、搜索、流式 UI 或 Phase 4 整体完成。

fixture 由 release 测试 harness 在系统临时目录确定性生成：10,000 headers、每 250 条一个独立 private payload，共 40 payload。测试后删除整个临时目录；原始 JSONL、payload、日志和完整命令输出未进入仓库。

## 运行方式

```text
cargo test --release --manifest-path src-tauri/Cargo.toml \
  macos_optimized_harness_10000_headers_and_real_pty -- --ignored --nocapture
pnpm test
pnpm typecheck
pnpm typecheck:ui
pnpm lint
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
pnpm build
pnpm tauri build --bundles app
```

## Release harness 结果

| 指标 | 结果 | 门槛 | 结论 |
|---|---:|---:|---|
| fixture 生成 | 188 ms | 记录项 | 通过 |
| 重启式 open/recovery | 25 ms | 记录项 | 通过 |
| 最近 100 headers | 45 µs | < 50 ms | 通过 |
| 10,000 headers 全分页 | 3 ms | < 500 ms | 通过 |
| 全分页唯一 sequence | 10,000 / 10,000 | 无漏、无重 | 通过 |
| 分页 payload read | 0 | 必须为 0 | 通过 |
| harness RSS 增量 | 7,264 KiB | < 65,536 KiB | 通过 |
| fixture 磁盘占用 | 3,326,628 bytes | 记录项 | 通过 |
| 真实 `/bin/cat` PTY 回显 p95 | 13 µs | < 50 ms | 通过 |
| PTY probe failure | 0 / 50 | 必须为 0 | 通过 |

PTY 探针与 20 轮 10,000-header 全分页压力并行执行。PTY 由 `portable-pty` 打开真实本机 pseudoterminal 并运行 `/bin/cat`；Event Store 使用自己的 mutex/worker，与 `PtyState`、PTY output ACK 和 shell 输入锁域完全分离。

## 行为与故障门

- Rust 定向测试：11 passed、1 ignored release harness；覆盖 durable/idempotent append、1 MiB private payload 与超限拒绝、显式 payload read、10,000 header 零 payload 预读、快照游标、页间 append、重启 sequence 延续、尾部半写恢复、中段损坏、未来 schema、payload hash 损坏、精确 task 删除、pending delete 重启续做、capability disabled→enabled 与严格字段边界。
- Rust 全量：201 passed、7 ignored、0 failed。Ignored 项是仓库既有的显式 SSH/压力门及本报告单独执行的 release harness。
- Node/UI/Rust 组合全量 `pnpm test` 通过；两套 typecheck、lint、production build、strict clippy 与 fmt check 通过。
- `pnpm tauri build --bundles app` 成功生成 optimized `Tunara.app`；隔离 bundle 本地 ad-hoc 签名后 `codesign --verify --deep --strict` 通过，bundle 约 14,844 KiB。
- capability 关闭只写持久 marker、不开 `v1` store；关闭不删除历史，重新开启恢复兼容数据。未知 schema、manifest/header 损坏只把 Event Store 置为 `migrationRequired/corrupt`，Tauri setup 仍管理 PTY 并继续启动。
- header 列表类型不含 private body；private payload 只有 trusted main 的单 event 显式读取 command 可访问。Preview capability 未获得任何 Agent Event Store command。

## 判定

M3 后端底座的 append、header/payload 分离、持久化、确定性分页、重启恢复、显式删除、capability 关闭、损坏/未来 schema fail-safe 与本机 10,000-header/真实 PTY 资源门通过。继续条件只开放到后续独立的富 Timeline UI 规格与实现；Phase 3 screenshot required gate、Phase 4 整体和 10,000 DOM/虚拟列表门仍未完成。
