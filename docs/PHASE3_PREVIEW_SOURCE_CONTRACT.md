# Phase 3 Workspace-bound Preview：来源绑定、安全 WebView 与导航策略

## 来源检测切片

在创建任何浏览器 surface 之前，先让终端输出中的本地开发 URL 成为可解释、不可跨 worktree 混淆的 Preview 候选。候选必须回答：属于哪个 repository、worktree、workspace、session 和 terminal，何时发现，当前来源是否仍存活，以及是否具备本地 Preview 资格。

## 复用点

- URL token 继续复用终端 quick-select 的提取器；本批只扩展它对 IPv6 loopback 与成对尾随标点的处理，不建立第二套通用链接检测器。
- 发现入口复用 `TerminalView` 唯一的 PTY `onData` 输出流，不读取持久 scrollback，也不扫描 DOM。
- repository/worktree 使用 Phase 1 的 `RepositoryRef / WorktreeRef / WorkspaceContext`。workspace hydration 尚未完成时，以 `transport + SSH authority + cwd` 形成明确的 fallback identity，而不是把来源归并到空值。
- 候选是 `Session.previewSources` 的 runtime-only 状态，不进入 workspace snapshot。
- 每个 session 最多保留最近 64 个不同来源候选，避免异常输出制造无界前端状态。

## 最小数据合同

```text
PreviewSource = {
  repositoryId, worktreeId, workspaceId,
  sessionId, terminalId, physicalPtyId?,
  sourceUrl, discoveredAt,
  transport: local | ssh,
  workspaceResolution: resolved | fallback,
  permission: eligible | remote-manual,
  state: active | stale,
  staleReason?
}
```

去重键包含 repository、worktree、workspace、session、terminal 与规范化 URL。同一 URL 在不同 worktree、不同 session 或不同 terminal generation 中是不同来源；同一来源重复输出保留第一次发现时间。

## URL 与权限边界

- 只把 `http:` / `https:` 且 hostname 精确为 `localhost`、`127.0.0.1`、`[::1]` 的 URL 记为候选。
- 显式端口必须是 `1..65535`；保留合法 path、query 与 fragment；剥离非 URL 的尾随标点和未配对闭合符号。
- 拒绝凭据 URL、非法协议、非法端口、任意公网域名和其他 IP。公网 HTTP(S) 可保持现有“外部浏览器链接”行为，但不获得 Preview 权限。
- 本地候选为 `eligible`，只表示可进入后续安全 surface 的策略评估，不表示本批已经打开页面。
- SSH 终端里的 loopback 记为 `remote-manual`。本批不直连、不探测远端端口、不修改远端配置、不创建 tunnel。
- 本批没有新增 WebView，因此没有网页可获得 Tauri invoke、opener、store、shell、文件或其他高权限桥接。

## 生命周期与降级

- PTY 输出可跨字节 chunk，scanner 使用流式 UTF-8 decoder，只提交越过空白/换行边界的新增文本并保留一个未完成 token；异常连续 token 以 4 KiB 为硬界，不重复解析 rolling history。完整来源键继续提供存储层幂等收敛。
- terminal exit 将该 terminal generation 的 active 候选变为 `stale / terminal-exited`，保留原 URL 与来源身份供后续 UI 解释。
- reconnect 使用新的 `terminalId` generation，不继承旧 generation 的 active 状态。
- workspace hydration 未完成时记录 fallback identity；不伪装成已解析 Git workspace。

## 本批测试与证据

- 两个 worktree 不同端口；相同 URL 的不同 worktree/session 来源；同一来源重复输出。
- localhost、IPv4/IPv6 loopback、query/fragment、尾随标点；公网 URL、凭据、非法协议与非法端口拒绝。
- SSH loopback 只获得 `remote-manual`；terminal exit 后保留 stale/source；hydration 前 local/SSH fallback identity 不混淆。

## 来源检测切片当时的 Non-scope

- 不创建 WebView、Preview tab 或 Inspector 页面。
- 不实现地址栏、刷新、前进/后退、缩放、viewport、截图、console/network 摘要。
- 不实现 URL 可达性探测、服务进程关联、SSH tunnel 或端口转发。
- 不进入 Phase 4，不改变 Agent Timeline。

## 安全 WebView surface 切片

本切片把 `eligible` 变成可由用户显式打开的独立原生 Preview window，但不建设通用浏览器。入口位于当前 session 的 Inspector Preview tab；每张来源卡完整显示 repository、worktree、session、terminal generation 与 URL，并提供打开/聚焦、刷新、关闭和外部浏览器逃生口。runtime state 的键继续包含完整来源身份，因此相同 URL、不同 worktree/session/terminal 不共享窗口。

### 双层准入

前端只启用 `transport=local + permission=eligible + state=active + workspaceResolution=resolved` 的内置打开按钮；Rust command boundary 再独立验证完全相同的条件、`workspaceId=repositoryId::worktreeId`、terminal generation 属于 session、URL 无凭据且为精确 loopback。SSH `remote-manual`、stale、fallback 和任意公网 URL 即使绕过 UI 构造 payload 也会被 Rust 拒绝。

### 独立 WebView 与 capability

- Preview 使用 `preview-<完整来源 SHA-256 前缀>` 的独立 `WebviewWindow`，不复用 `main` 窗口。
- `preview-untrusted-loopback` capability 只匹配明确 loopback remote URL，并设置 `local=false / permissions=[]`；主窗口的 opener、store、dialog、updater、window-state 等 capability 只匹配 `main`。
- 远程页面仍必须用真实 fixture 主动探测 `window.__TAURI_INTERNALS__ / window.__TAURI__` 并尝试代表性 app command 与 plugin command；空 permissions 只是结构证明，不能替代运行时拒绝证据。
- 用户用原生关闭按钮销毁 Preview 时，`WindowEvent::Destroyed` 清除 Rust 注册状态；之后同一来源可重新创建。页面加载失败或 Preview 关闭不关闭 PTY，不隐藏或销毁主窗口。

### 集中导航策略

Rust `allowed_origin / navigation_allowed` 是唯一 top-level policy：初始 URL 必须为无凭据的 HTTP(S) 精确 loopback；后续 top-level navigation 与 redirect 必须保持与初始来源完全相同的 scheme、host 和 effective port。路径、query、fragment 可变化；跨端口 loopback、公网 redirect、外部协议、凭据 URL全部 fail closed。

`window.open` / popup 固定返回 `Deny`；download handler 固定返回 `false`；不向页面提供地址栏、前进后退、缩放、viewport、DevTools、书签、账号或标签页。外部浏览器动作只存在于可信的 main Inspector 控制面，不由不可信页面静默触发。

## 本批真实验收门

- optimized macOS Tauri app 加载受控 eligible fixture；主动 IPC/app/plugin 探针只能得到桥接缺失或 capability 拒绝。
- 同 origin navigation 与刷新成立；公网 redirect、跨端口 loopback、外部协议、popup、download 均不离开/不落盘/不生成新页面。
- 两个 linked worktree、不同 session/terminal/端口的来源标签与窗口保持独立。
- 用户原生关闭后可再次打开；页面失败、关闭与刷新不影响 PTY 输入回显及 main window。

## 最小运行时状态与服务生命周期切片

本切片只在可信 main Inspector 中补齐观察与手动恢复，不把 Preview 扩成通用浏览器。Rust 以完整来源身份的 SHA-256 label 作为状态键；键覆盖 repository、worktree、workspace、session、terminal generation 与 source URL。每次原生窗口创建另有单调 `windowGeneration`，所有 page-load、timeout 与 Destroyed 回调都必须同时匹配 label 和 generation，旧窗口不能删除或污染同来源重开的新窗口。

### 状态合同

```text
closed -> opening -> loading -> ready
                    |         |
                    +-------> failed
failed --manual Refresh--> loading -> ready | failed
active source --terminal exit--> stale / terminal-exited
```

- `opening / loading`：窗口创建或当前页面加载尚未完成；Refresh 在此期间禁用，避免并发导航代次。
- `ready`：精确来源端口可达，且 WKWebView 已完成当前 URL 的页面加载。失败时不得继续显示 ready。
- `failed`：初始精确 loopback 端口不可达、Refresh 时端口已停止、窗口操作失败，或页面在 8 秒内未完成。Inspector 显示解释文字并保留 Refresh、Close 与外部浏览器逃生口。
- `closed`：没有该完整来源键对应的原生窗口。原生关闭与控制面 Close 都清除 runtime entry。
- `stale / terminal-exited`：来源终端 generation 已退出。已打开窗口仍可 Close，外部浏览器仍可用；Focus、Refresh 与新建内置 Preview 被拒绝。新 terminal generation 必须重新输出 URL 才能建立新的 active 来源。

状态只存在 Rust runtime map 与前端轮询视图，不进入 workspace/session snapshot。前端轮询采用单飞与 request sequence，迟到响应不能覆盖用户刚触发的 opening/loading/failed 状态。

### 精确可达性边界

Open/Refresh 只对已经通过 active/resolved/local/eligible 与精确 loopback URL 校验的**当前 source host + effective port**做 350ms TCP connect。它不发送 HTTP 请求、不扫描相邻端口、不访问公网、不启动或重启服务、不杀进程。连接失败立即 fail closed；连接成功后仍由集中 navigation policy 与 page-load generation 决定 loading/ready。服务恢复只在用户再次点击 Refresh 后观察，不自动关联进程。

Refresh 每次只执行一个操作：已有 ready 页面使用 reload，初始/既有 failed 页面使用 validated source navigate；不再叠加 `reload + navigate`。页面 navigation、popup、download、外部协议、公网 redirect 与 capability ACL 继续沿用上一切片的安全边界。

### 本切片真实验收门

- optimized macOS 隔离 identifier 应用：正常 opening/loading 后 ready；初始不可达明确 failed。
- ready 服务停止后，手动 Refresh 进入 failed，main 与 PTY 保持；服务恢复后再次 Refresh 回 ready。
- terminal exit 后来源显示 stale/terminal-exited，不允许新建或刷新内置 Preview，但可 Close/外部打开。
- 两个 linked worktree、不同 session/terminal/端口同时存在；一端失败不改变另一端 ready。
- 原生关闭后状态回 closed；同一来源重开回 ready，旧 Destroyed/timeout 不留下残留。
- fixture 再次确认页面 app/plugin ACL 拒绝；原始 JSONL、应用日志与截图仅本机保留并由 `.gitignore` 排除。

## 可信地址导航与原生历史切片

本切片只在可信 `main` Inspector 控制面增加地址输入、Back 与 Forward；不可信 Preview 页面仍没有地址控制、应用命令或 plugin capability。用户可输入相对 path/query/fragment 或完整 URL，Rust command boundary 以当前 Preview URL 解析后，再与该来源最初批准的 scheme、host、effective port 做严格相等校验。空输入、非法 URL、凭据、跨 scheme/host/port、公网、外部协议均 fail closed；redirect、页面 history、popup 与 download 仍必须经过既有集中 navigation policy，不能扩大来源。

`preview_status` 返回当前 Preview window 的真实 URL 与 macOS `WKWebView` 原生 `canGoBack / canGoForward`。Back/Forward 命令在 Rust 侧再次读取同一原生 back-forward list 后才执行，不接受 React 维护的历史索引。runtime entry 仍使用 repository/worktree/workspace/session/terminal/source URL 完整键，并由 window generation 约束 page-load、timeout 与 Destroyed；关闭重开创建新的 WKWebView，不继承旧窗口历史。

### 本切片真实验收门

- optimized macOS 隔离 identifier 应用完成来源 A → 同源 B → Back → Forward，地址与两个按钮状态分别回到真实当前项。
- 相对地址和完整同源地址成立；跨端口 loopback 与公网完整 URL 在可信控制面明确拒绝，Preview 当前页不变。
- 两个 linked worktree、不同 terminal generation 与端口的窗口同时存在；一端有 Back 历史时另一端仍无历史。
- 服务停止后 Refresh 仍进入 failed，恢复后手动 Refresh 回 ready；失败期间 main 与 PTY 保持。
- 带历史窗口原生关闭后回 closed；重开从批准来源 URL 开始，Back/Forward 均 disabled，无旧 generation 残留。
- 既有精确 origin redirect、popup、download、ACL、stale、初始不可达与生命周期自动门继续回归。

## 可信缩放与常用 viewport 切片

- 控件只存在于可信 main Inspector；不可信页面仍无 Tauri/app/plugin capability，也没有页面内 bridge。
- Zoom 直接使用 macOS `WKWebView.pageZoom`，仅接受 75/90/100/110/125/150%；Rust 在执行前拒绝 NaN、无限值、越界和非预设值，并在返回成功前读取原生值确认。Reset 为 100%。
- Viewport 仅接受 phone 390×844、tablet 768×1024、desktop 1280×720，另有 Fit 与 Reset（980×720）。macOS Rust 边界从 `WKWebView.frame` 扣除原生 `safeAreaInsets` 得到真实 CSS 内容尺寸，异步等待窗口 resize 提交后再回读；另行报告 outer logical size。只有实际 CSS 内容尺寸命中目标才标记 exact，屏幕约束导致不一致时明确返回 unavailable，不把 Tauri window inner、outer 或请求值伪装成页面 viewport。
- zoom/viewport 状态只存在于完整来源键对应的 Rust runtime entry，并受 window generation 保护；不进入 workspace snapshot。原生关闭销毁 entry，重开默认恢复 100% 与 980×720。
- 受控 loopback fixture 自行报告页面 `innerWidth/innerHeight/devicePixelRatio`，真实验收以该页面事实与 Rust 的 WKWebView frame/safe-area、outer 状态交叉核对，不向普通页面注入测量脚本。
- viewport 动作只改变对应 `preview-*` 原生窗口，不调整 main window、Inspector 或 PTY rows/cols。

## 用户触发的来源绑定截图与安全送回切片

截图只由可信 `main` Inspector 中的用户显式动作触发；不可信 Preview 页面不获得截图、PTY、文件、shell、store、opener 或其他 app/plugin bridge，也不能自行截图、持续录屏或后台定时抓取。Rust command boundary 以完整 repository/worktree/workspace/session/terminal/source URL 来源键定位当前 `preview-*` WKWebView，并再次核对 active/resolved/local/eligible、真实窗口 label、当前 URL、physical PTY 与单调 window generation。窗口关闭、来源 stale、terminal exit、generation/URL/viewport/zoom 在捕获期间变化、窗口缺失或原生捕获不可用时均 fail closed；不允许退化为主窗口、整屏或其他应用截图。

- macOS 只使用 `WKWebView.takeSnapshot`，并以原生 safe-area 裁出页面内容；PNG 像素不包含 Preview titlebar、main、PTY、桌面或其他 worktree Preview。只接受 PNG，像素上限 16,777,216、编码上限 32 MiB；非法、过大或不支持格式在写盘前拒绝。
- 原始 PNG 与原始 metadata 仅写入 app cache 的 `preview-evidence` 本机目录，使用不可覆盖的新文件；安全本地引用以 `$HOME` 别名表达，不暴露用户名或绝对路径。它们不进入 workspace snapshot、Git、Journal 或远程同步。
- 每条 metadata 只含脱敏 repository/worktree 摘要、workspace/session/terminal/source URL 的 SHA-256 安全引用、去 query/fragment/credentials 的安全 origin、捕获时间、页面 CSS viewport、原生 zoom、window generation、PNG 格式/像素尺寸/字节数/SHA-256。文件名不使用用户名、路径、session id、token、Cookie、URL 凭据或页面内容。
- Copy 只复制由 Rust 返回的安全单行引用。Send 在 Rust 侧再次核对 capture 的来源 label/generation 与当前 logical-to-physical PTY 映射，只把“安全本地引用 + 同源 origin + 脱敏来源摘要”写入该来源真实 physical PTY 输入区；不接受当前选中但来源不同的 PTY，不复制 PNG/base64，不附加 CR/LF，不执行。
- 关闭重开创建新 window generation，旧 capture 引用不能送入新窗口对应 PTY；两 worktree 即使 URL 形状相似也不共享截图记录。运行时仅保留有界索引，原始 artifact 生命周期仍是本机 evidence/cache 管理责任，不扩展为通用截图管理器。

### 本切片真实验收门

- optimized macOS 隔离 identifier 应用连接两个 detached/linked worktree、两个 loopback fixture 与两条真实 PTY；分别以 390×844/125% 和 768×1024/90% 捕获，再关闭重开来源 A 于 980×720/100% 捕获。
- fixture 的 `innerWidth/innerHeight/devicePixelRatio`、WKWebView zoom 与 PNG 像素交叉可解释；三张原图人工检查只含对应页面，不含 main、PTY、另一个 Preview、桌面或其他应用。
- A/B Send 只填入各自 physical PTY，另一 PTY 不变且没有执行；跨来源、关闭、旧 generation、stale/terminal-exit 与无窗口动作拒绝。
- 中英文可信控制面由真实组件与自动 UI 门覆盖；390px 窄 Preview、双 worktree、既有 navigation/history/zoom/viewport/lifecycle/ACL/popup/download 回归保持。
- Git 只收录脱敏报告和结构化汇总；原始 PNG、metadata、fixture JSONL、应用日志与完整命令输出仅留 ignored/cache/temp，并在验收后清理。

## 基础失败 telemetry 与绑定 PTY 送回切片

本切片只收集用户已显式打开、仍 active/resolved/local/eligible 的 Preview runtime 中三类失败：`console-error`、`unhandled-error`、`network-failure`。它不是 Console 面板或 Network waterfall，不记录成功请求、body、headers、cookies、storage、完整 stack、性能 trace 或任意对象/二进制数据。

- macOS 在每次同源页面 `Finished` 后向该 `preview-*` WebView 注入闭包式最小包装器；包装器只提交上述严格 schema，页面 capability 只允许 `preview_telemetry_ingest`。页面仍不能调用 PTY、文件、shell、store、opener、core 或其他 app/plugin 命令。
- ingest 同时核对真实调用 WebView label、当前 URL origin、完整 repository/worktree/workspace/session/terminal/source URL 来源键、系统随机 32 字节（64 hex 字符）generation nonce 与当前 window generation。关闭、重开、跨端口、跨来源、旧 generation、stale 或 terminal exit 均 fail closed；handler 与 nonce 随 WebView/runtime entry 销毁。
- console/unhandled 只接受有界文字；network 只接受 allowlist method、status 与 `fetch/xhr/resource/request` phase。相对 URL 先按当前页面解析，再只保留同源脱敏 path；凭据、query、fragment、secret marker、用户名、绝对路径和长高熵 token 被移除或替换。外部 origin 只显示 `<external>`。
- 单 generation 最多保留 32 条不同事件；相同 kind/message 去重并累加 count；Rust 每 10 秒最多接收 40 条，页面每秒最多提交 12 条，超限只增加 bounded dropped count。telemetry 只存在 Rust runtime，不进入 workspace snapshot、Journal 或远程同步。
- 可信 main Inspector 显示 bounded failure summary，并提供 Copy、Clear 与显式 Send。Send 在 Rust 侧重新生成单行脱敏摘要，重新核对来源绑定的 `physicalPtyId` 仍存在，只写入该真实 PTY 输入区；不接受当前选中但来源不同的 PTY，也不附加 CR/LF 或执行。
- main capability 通过显式 `allow-main-commands` 保留既有可信应用命令；不可信 Preview capability 仍只有 ingest。release 构建必须检查 ACL pruning 输出，确保既有 PTY/Preview 主窗口命令未被意外裁掉。

### 本切片真实验收门

- optimized macOS 隔离 identifier 应用连接两个 linked worktree、两个 loopback 端口与两条真实 PTY；A/B 分别产生可区分的 console、unhandled 与 HTTP 503 fetch 失败，Inspector 只显示对应脱敏摘要。
- A/B Send 分别只填入各自物理 PTY，未附加回车、未执行；Clear 清空当前 generation 的 bounded buffer。
- A 原生关闭/重开后 generation 变化，旧窗口事件不污染新 entry，B 事件不进入 A。
- 页面对 `fs_read_file`、store、`pty_write` 均得到 ACL 拒绝；伪造 telemetry nonce 到达窄 ingest 后仍被 generation 校验拒绝，没有任意高权限桥。
- 原始 fixture JSONL、应用日志、截图和完整命令输出只保留本机 ignored/temp，Git 只收录本脱敏合同、报告和结构化代码/测试。

## 来源绑定的 fail-closed 服务重启准备切片

本切片不建设进程管理器或服务编排。可信 main Inspector 在 Preview `failed` 时继续展示 repository、worktree、workspace、session、terminal generation、source URL 与 physical PTY 的完整来源键，并提供“查看来源终端”。重启入口只是一项显式准备动作：把同一 terminal generation 已经真实提交过、且由 Rust 再验证的安全服务启动命令填入该 physical PTY 输入区；不附加 CR/LF、不执行、不自动聚焦后提交。

### 命令 provenance 与顺序

- xterm 解析真实 OSC 133 `C/D` 后，main 才把 command、submitted timestamp、单调 sequence 与 terminal generation 送入 Rust runtime map。Preview URL 扫描在 xterm 完成同一输出批次解析后运行，因此服务极快输出 URL 时也不会错误绑定上一代命令。
- 同一完整来源再次输出 URL 时，只允许用当前 Rust command record 可证明的新 generation 更新 runtime provenance；保留首次发现时间。旧来源对象、旧窗口 failure 或迟到输出不能获得新 generation 的资格。
- provenance、Preview source、failure/restart eligibility 只驻留内存，不进入 workspace snapshot、Journal 或远程同步。关闭重开、terminal exit 与另一来源不继承旧状态。

### Rust fail-closed 边界

- `preview_restart_prepare` 仅属于可信 main capability；不可信 Preview capability 仍只有严格 telemetry ingest。
- Rust 同时核对 active/resolved/local/eligible、完整来源键、source URL、physical PTY、terminal generation/sequence/timestamp、命令指纹、当前 command record 与 failed runtime。PTY 忙碌、已退出、来源 stale、generation 改变、跨 worktree/端口、重复 prepare 或任何竞争都拒绝并返回可解释原因。
- 命令上限为 384 bytes，只接受窄服务启动形状；拒绝 CR/LF、控制字符、首尾空白、compound/subshell、重定向、pipe、引号/转义/通配等 shell 结构及任意危险命令。不从页面、URL、端口、进程列表或历史记录猜命令，不扫描端口，不修改项目文件、脚本或配置。
- prepare 持有 runtime 与 command state 锁完成最后一次核对，再只写命令字节到绑定 PTY，并以 one-shot `prepared` 阻止重复填入。用户必须在真实终端中检查并显式提交。

### 本切片真实验收门

- optimized macOS 隔离 identifier 应用连接两个 linked worktree、两个 loopback 服务与两条真实 PTY；A/B 初始均 ready，停止 A 并 Refresh 后只有 A failed 且重启可准备，B 保持 ready。
- Inspector 显示 A 的完整来源键；“查看来源终端”回到并聚焦 A 的真实 xterm。重启按钮只把命令填入 A，B snapshot 不变，A 服务仍未监听；用户显式回车后 A 恢复 ready。
- 跨来源、旧 generation、关闭重开残留、不可信后续命令与 terminal exit 全部拒绝；恢复后的新 URL 只绑定新 generation。
- Preview 页面主动尝试文件、store、PTY 与 app command，0 次意外成功；main 与另一 PTY 正常。验收不依赖 Accessibility。
- 原始终端尾部、应用日志、fixture 与 bundle 只留本机临时路径并在交付前清理；Git 只收录脱敏结论、代码与测试。

## SSH remote loopback 显式转发闭环

### 来源与用户动作

- SSH terminal 输出中的合法 `localhost`、`127.0.0.1`、`[::1]` URL 仍先记录为 `remote-manual`，不会自动建立 tunnel。只有可信 main Inspector 对当前 active/resolved 来源执行“建立转发并打开”，并提供一次性 256-bit action nonce，才进入 opening。
- 来源键除既有 repository/worktree/workspace/session/terminal generation/physical PTY/remote URL 外，还固定 SSH host、port、user 与逻辑 session。Rust 在监听前后都重新核对注册来源、同一 `Arc<Session>`、连接存活及完整来源；nonce 全局有界去重。
- 原始 remote URL 永久保留在派生来源的 `remoteSourceUrl`；OS 通过 `127.0.0.1:0` 分配本地端口，实际 `localEndpoint` 明确标记为 `forwarded`。相同远端 URL/端口的不同 session/worktree 不共享 tunnel 或 Preview identity。

### 窄 transport 与生命周期

- tunnel 只复用来源绑定的既有 authenticated russh handle，并仅调用 `channel_open_direct_tcpip` 到已验证 remote loopback 的精确 effective port；不拼 shell，不读取或复制凭据，不扫描端口，不支持公网目标、`0.0.0.0`、reverse、dynamic 或 SOCKS。
- 本地 listener 只绑定 `127.0.0.1` 的 OS 分配端口；每个 tunnel 最多同时处理 32 个本机 loopback 连接。建立 probe、relay channel 或 listener 失败都会进入带原因的 failed，不会改远端服务或项目。
- 显式关闭 Preview/tunnel、physical PTY replacement、terminal/SSH exit 与 app exit 都取消 listener 和 relay tasks。remote service 停止后的下一次原生 Preview 请求使对应 tunnel/Preview failed，其他来源保持 ready；恢复必须重新显式建立，不从 snapshot、Journal 或重开窗口恢复。
- Preview capability 仍只有 telemetry ingest；页面不能观察、建立、重配或关闭 tunnel，也不能获得 SSH、PTY、file、store、shell 或 app command。

### 真实验收门

- optimized macOS 隔离 identifier 应用使用真实 codex-netcup transport、两个独立 SSH Git workspace/session/physical PTY，以及同一 remote port 上可区分的 IPv4/IPv6 loopback 服务。A/B 显式建立后获得不同本地端点，两个 WKWebView 分别完成页面与 ACL telemetry。
- 停止 A 后以 A 的原生 Preview Refresh 触发 relay failure：只有 A 为 failed，B 保持 ready；显式关闭 B 后 runtime/listener 消失，新 nonce 显式重建才恢复。B terminal/SSH exit 后 listener 回收，旧来源动作拒绝。
- 并发建立只能有一个 winner；nonce replay、跨 worktree、stale 与旧 physical generation 全部拒绝。页面对 file/store/PTY/SSH/tunnel/app 六类高权限探针 0 次意外成功。详见[脱敏报告](./benchmarks/phase3-preview-ssh-tunnel-macos-2026-07-13.md)。
