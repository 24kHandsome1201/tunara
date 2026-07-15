# M3 Agent Timeline 全文搜索与轻量索引短规格

## 唯一目标与边界

本切片只关闭 Phase 4 最后一个 required gate：在现有 Agent Timeline 上增加本地全文搜索、轻量持久索引和必要筛选。继续复用 Rust Event Store、typed IPC、Timeline 虚拟列表、private payload 惰性读取、Inspector、全局 tokens/CSS 与真实 PTY 跳转。不增加聊天壳、composer、卡片墙、通用查询语言、正则、语义向量、模型搜索、云服务、Agent 协调、PTY 自动写入、Mobile Companion、Task Journal 或 Phase 5+。

## 查询语义、scope、排序与游标

- 查询在 Rust 持久索引上执行，前端不预取完整 Timeline、header 集合或 private payload。首次打开 Timeline 仍只取最新 100 个 header。
- 规范化采用 Unicode 小写、连续空白折叠和首尾空白删除，不做语言相关分词或模糊改写。空格分隔的 1 至 8 个 token 使用 AND 语义；中文、英文、路径、代码符号与长词均按确定性 Unicode 子串匹配。
- 查询必须包含至少 2 个 Unicode scalar，最多 128 个 scalar；单 token 最多 64 个 scalar。拒绝空查询、控制字符、超长、过多 token 与过宽单字符查询。单次查询最多 75ms、默认 50 条、最大 100 条。
- scope 只接受结构化 `all`、精确 workspace 或精确 workspace+task。Timeline UI 只暴露当前 task 与当前 workspace，不提供任意路径或跨 workspace 搜索。
- 最小筛选只接受已有 header 可证明的 `kind`、`source` 与 occurred-at 时间上下界；每类最多 9/6 个枚举值，不接受 regex、glob、自由字段或表达式。
- 结果按 Event Store `sequence` newest-first 排序，不按相关性或客户端时间重排。opaque v1 游标绑定规范化查询 hash、scope、筛选、snapshot upper bound、delete generation 与 index generation；stale、跨 scope、删除后或重建后的游标返回 `invalidSearchCursor`。

## 索引内容、数据位置、预算与隐私

索引位于 Event Store 受控根目录内的 `v1/search-v1/`：

```text
search-v1/
  manifest.json       # schemaVersion、deleteGeneration、indexGeneration
  documents.jsonl     # 按 sequence 递增的受限搜索文档
```

- 每个 Event Store header 对应一个索引文档，保存 event/provenance/filter 元数据、header summary，以及允许索引的 payload 文本。
- `text/plain`、`text/markdown`、`application/json`、`text/x-diff` 索引完整 UTF-8 body；图片只索引可信 header metadata：content type、byte length 与 SHA-256，不读取、解码或 OCR 图片 body。
- 索引不扫描工作区、PTY scrollback、网络或任意文件。显式重建只遍历已验证的 Event Store header 和其受控 payload 文件。
- 单文档仍受 Event Store 1MiB payload 上限约束；索引总量最多 256MiB，最多 100,000 文档。达到预算后 Event Store append 继续成功，但搜索 fail closed 为可解释的 `quotaExceeded`，普通 Timeline 与真实 PTY 不受影响。
- 索引是本机 private data，不进入日志、遥测、导出、前端持久快照或 Git。日志和脱敏证据只记录计数、字节、延迟、RSS、错误类与 payload-read 计数。

## append、重启、删除、迁移与重建

- 新空 Event Store 同时建立空索引。健康索引在 header durable append 后按同一 sequence 追加并 sync；幂等 duplicate 不重复建文档。若索引写入失败，已持久 Event Store 事实不回滚，搜索进入 degraded/fail-closed，Timeline/PTY 保持可用。
- 启动只验证 search manifest、schema、delete generation、文档顺序/数量、event ID、payload type/size/hash metadata 与 Event Store header 一致性，不静默补漏。缺失、局部损坏、future schema、generation 不一致或迁移失败只关闭搜索。
- workspace/task/all 显式删除会同步物理移除对应搜索文档并提升 delete generation；无法安全重写时删除失败且保留 pending journal，重启继续。若旧索引本已不可读，则先安全删除整个索引目录，Event Store 删除完成后保持 `missing`，等待用户显式重建，避免残留被删正文。
- capability 关闭期间 append/list/payload/search/rebuild 均不可用，但显式 all 清理仍可物理删除 Event Store 和索引。重新开启只恢复兼容且完整的 v1；不自动迁移未来 schema。
- `agent_event_search_rebuild` 是唯一重建入口，要求 `confirmed: true`。它从受信任 Event Store 显式读取并校验允许的 payload，写临时目录、sync 后原子替换；失败保留旧健康索引或保持 fail-closed，不扫描任意 workspace 文件。

## 结果、摘要、高亮与 UI 合同

- 每条结果只返回现有轻量 header、最多 240 Unicode scalar 的匹配摘要、命中字段 `summary|payload|imageMetadata`、以及最多 8 个 `[startChar,endChar)` 范围。范围以摘要 Unicode scalar 计数，Rust 生成前检查边界；前端再次夹紧，越界时退化为无高亮文本。
- 搜索结果继续使用原 Timeline row、虚拟列表、来源/confidence/kind/time 语义与原事件惰性 payload manager。点开结果才读取 payload；搜索命中本身不调用 payload IPC。来源无法证明时仍显示 `unknown` 且禁用 PTY 跳转。
- 搜索输入 debounce 180ms，并用 request generation 丢弃快速输入、scope 切换、capability 变化或卸载后的 stale 结果。搜索分页最多保留 600 个轻量结果，DOM 仍只渲染 viewport+overscan。
- 清除搜索恢复进入搜索前的 Timeline task view state：原 scroll anchor、selection、unread 与 bottom-follow 语义；Escape 先清查询，再按现有规则折叠 payload 或回到真实 PTY。所有输入、筛选、分页和结果操作可键盘到达。

## 错误、证据与停止条件

- `missing`、`corrupt`、`migrationRequired`、`quotaExceeded`、`unavailable` 均显示稳定错误类和显式重建入口，不回显数据路径、正文或任意 payload。普通 Timeline 继续工作。
- 确定性证据覆盖 10,000 headers、1,000 Markdown code blocks、500 tool calls、200 diffs、100 images，证明首次打开零全文/payload preload；索引与查询时间、RSS、磁盘、分页、DOM、payload read、cache 和快速输入 stale 丢弃均在预算内。
- 必跑定向 React/Node/Rust、Node/UI/Rust 全量、两套 typecheck、lint、`cargo fmt --check`、严格 clippy、frontend production build、optimized/release macOS Tauri、strict codesign、`git diff --check`，以及重启、删除、重建、损坏、future schema、capability 关闭/重开、scope 隔离、中英文和真实 PTY 门。
- 真实 WKWebView 验收覆盖两次 app 重启、搜索/筛选/分页、快速输入、结果展开、task/workspace 切换、后台/前台、576×433、640×480、1200×800 与真实像素检查。原始 fixture、索引、日志、截图、录屏、图片 payload 和完整命令输出只留 Mac 内置 ignored/cache/temp。
- 任一 required gate 未真实通过就不把 Phase 4 标记完成、不提交、不推送、不进入 Phase 5。
