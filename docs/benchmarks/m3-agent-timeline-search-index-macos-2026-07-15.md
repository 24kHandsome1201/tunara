# M3 Agent Timeline 搜索与轻量索引 macOS 关闭证据

日期：2026-07-15

基线：`origin/main` `5fc8c4ec99bfcd8286abca270ad0082e26b0ab26`

环境：Apple Silicon macOS、optimized/release Tauri WKWebView、真实本地 PTY、仅 Mac 内置磁盘。worktree 位于 `~/.codex/worktrees`，Rust target 链接到 `/private/tmp/rail-phase4-target`；fixture、索引、日志和像素证据只进入隔离 Application Support 与 `/tmp`，不进入 Git。

## 合同与实现

- [搜索与索引短规格](../specs/m3-agent-timeline-search-index.md)固定查询规范化、scope、筛选、游标、排序、索引版本/预算/隐私、append/delete/restart/rebuild/corruption/capability 与 UI 降级。
- Rust Event Store 在 `v1/search-v1` 维护受限 `manifest.json + documents.jsonl`。查询只扫描轻量索引，结果只返回 header、最多 240 Unicode scalar 的摘要、安全高亮范围与 opaque cursor；不会读取 payload 或扫描 workspace。
- Markdown、code、diff、tool text 可索引；图片只使用可信 content type、字节数和 SHA-256 metadata，不读取图片正文、不解码、不 OCR。索引总上限 256MiB、100,000 documents，查询 75ms、8 tokens、100 results 硬上限。
- 缺失、局部损坏、future schema、generation 不一致和 capability 关闭均只让搜索 fail closed；Timeline 与真实 PTY 保持工作。显式重建只遍历已验证 Event Store。
- UI 复用现有 Inspector、Timeline row、虚拟列表、payload manager、tokens/CSS 与真实 PTY 跳转。搜索结果关闭可见预取，展开前 payload read 为 0；普通 feed 保持同一 DOM/scroll 几何，清除搜索精确恢复 event anchor。

## 确定性后端证据

optimized Rust harness：

```text
fixture_ms=177
first_open_ms=13
rebuild_ms=78
restart_one_ms=20
restart_two_ms=20
english_query_us=15483
chinese_query_us=20772
documents=10000
markdown=1000
tools=500
diffs=200
images=100
first_open_payload_reads=0
query_payload_reads=0
rss_delta_kib=9136
disk_bytes=7607926
```

Rust tests还覆盖：幂等 append 与 durable restart、task/workspace scope 隔离、newest-first 分页、stale/delete/rebuild cursor、显式删除、损坏与 future schema、缺失索引、capability 关闭/重开、显式重建、图片 metadata-only、Unicode 查询与越界安全高亮。宽查询的 header 关联使用 sequence 二分查找，避免 O(n²) 路径，同时保留 75ms fail-closed 时间预算。

## optimized macOS WKWebView 与真实 PTY

`scripts/benchmark-m3-agent-timeline.sh run` 使用独立 bundle identifier 和隔离 Application Support，连续启动两次 optimized/release app。两轮总结果均为 `passed: true`，第二轮 `restartRecovered: true`。

| 门 | 首轮 | 重启轮 |
|---|---:|---:|
| 首次 Timeline 可用 | 98ms | 101ms |
| 搜索索引状态 | missing -> UI 显式重建 131ms | ready，无重建 |
| 五组后端查询总耗时 | 114ms | 120ms |
| 英文/中文首分页 | 50/50 | 50/50 |
| Markdown payload 命中 | 1 | 1 |
| 图片 metadata 命中 | 50 | 50 |
| task B 隔离命中 | 50 | 50 |
| 搜索首屏 payload read | 0 | 0 |
| 展开 Markdown 后 read | 1 | 1 |
| 搜索分页保留 | 100 | 100 |
| 搜索 DOM rows | 8 | 8 |
| 清除前/后 event anchor | 8906/8906 | 8907/8907 |
| 快速滚动 p95 | 18ms | 19ms |
| PTY 搜索前/后回显 | 24/17ms | 23/30ms |
| process RSS | 132,912KiB | 128,192KiB |

同一真实 app 还通过：快速输入只保留最终 `Build transition`、kind 筛选、Older 分页、结果惰性展开、task A/B 切换、workspace/task 后端隔离、中英文 locale、后台/前台，以及 576×433、640×480、1200×800 三种逻辑窗口无横向 overflow。Retina physical size 分别为 1152×866、1280×960、2400×1600。

Computer Use 在保留的第二轮 release app 上完成真实像素检查：1200×800 逻辑布局中 Terminal 与高密度 Timeline 同屏清晰；搜索框写入 `Build transition` 后，accessibility tree 明确出现 `TIMELINE SEARCH`、`50 retained results`、Clear、Older、Task/Kind/Source 筛选及首条来源优先结果。普通画面与搜索变化截图仅留 `/tmp/tunara-m3-timeline-*.jpeg`，不合入仓库。

## 门禁与停止条件

以下最终门在同一变更上通过：Node/UI/Rust 全量、两套 typecheck、lint、`cargo fmt --check`、严格 clippy、frontend production build、optimized/release Tauri app、带 hardened runtime entitlements 的 ad-hoc strict codesign、本机 legacy fallback bundle verifier、`git diff --check`、10,000 + 富 payload harness、两次真实 WKWebView/PTY 与真实像素检查。本机 `security find-identity -p codesigning` 为 0，因此需要 Developer ID、Team ID 与 notarization 凭证的 CI release verifier 不在本机伪报通过。

Phase 4 的 Event Store、Timeline、private payload 富渲染、全文搜索与持久层轻量索引 required gates 至此全部满足。此批在 Phase 4 停止，不创建或进入 Phase 5。
