# Architecture

How the React frontend and the Rust (Tauri 2) backend fit together, and where
to look when you need to change something. This is a map of the boundary, not a
feature list — for what Tunara *is*, see the [README](../README.md); for
capabilities mapped to code, see [FEATURES.md](./FEATURES.md).

## The shell

The whole UI is one window. [`src/app/App.tsx`](../src/app/App.tsx) renders a
fixed three-pane layout under a custom titlebar:

```
┌──────────────────────────────────────────────────────────────┐
│ Titlebar                              (src/ui/Titlebar.tsx)    │
├────────────┬─────────────────────────────────┬───────────────┤
│            │                                 │               │
│ Sidebar    │  MainArea                       │ InspectorPanel│
│ (sessions  │  (xterm.js terminals,           │ (read-only    │
│  grouped   │   split panes)                  │  git diff +   │
│  by dir)   │                                 │  file tree)   │
│            │                                 │               │
│ Sidebar.tsx│  MainArea.tsx / TerminalView.tsx│ InspectorPanel│
└────────────┴─────────────────────────────────┴───────────────┘
```

- **Left — `Sidebar`** ([`src/ui/Sidebar.tsx`](../src/ui/Sidebar.tsx)): session
  list grouped by local working directory or SSH target host, plus a derived
  attention/running/recovery layer for SSH, commands, and agents.
- **Center — `MainArea`** ([`src/ui/MainArea.tsx`](../src/ui/MainArea.tsx) →
  [`TerminalView`](../src/ui/TerminalView.tsx)): the actual terminals. xterm.js +
  WebGL, one per session, optionally split into two panes.
- **Right: `InspectorPanel`** ([`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx)):
  overview, read-only git diff ([`DiffPanel`](../src/ui/DiffPanel.tsx)),
  file tree ([`FileExplorer`](../src/ui/FileExplorer.tsx)), bounded text/Markdown
  reading and safe editing ([`FilePreview`](../src/ui/FilePreview.tsx)), Preview
  controls, session notes, and SSH-only tabs (transfers, metadata, forwarding,
  diagnostics, known hosts). Tab availability is computed in
  [`inspector-navigation.ts`](../src/ui/inspector-navigation.ts). Only the
  active Inspector tab is mounted.

Auxiliary panes switch to floating overlays when docking them would shrink the
terminal workspace below a usable width (280px per split column, 480px for a
single pane). The decision lives in
[`src/app/lib/app-shell-layout.ts`](../src/app/lib/app-shell-layout.ts) and is
not a pair of fixed 720/900px viewport cliffs. Overlays (`Settings`,
`CommandPalette`, `SshConnect`, `HostKeyPromptDialog`,
`KeyboardInteractivePromptDialog`, `WorkflowParamPrompt`, `ToastContainer`)
are rendered as siblings, gated on `useUIStore`. The three Zustand stores
under [`src/state/`](../src/state/) are `sessions`, `ui`, and `workflows`;
`persist` provides snapshot I/O rather than a fourth store.

### macOS titlebar contract

The macOS window is a Tauri overlay titlebar, not a fully borderless custom
window. Native traffic lights come from [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json):
`titleBarStyle: "Overlay"`, `hiddenTitle: true`, and
`trafficLightPosition: { "x": 18, "y": 18 }`.

The React titlebar height comes from [`src/styles/tokens.css`](../src/styles/tokens.css)
(`--h-titlebar: 36px`). Raising this token adds visible blank space below the
traffic lights. Tunara's custom titlebar controls are optically aligned in
[`src/ui/Titlebar.tsx`](../src/ui/Titlebar.tsx) with
`MAC_TITLEBAR_CONTROL_Y_OFFSET = -1`. If the icons align with the traffic lights
but the bottom of the titlebar still has excess whitespace, fix the structural
height token first instead of repeatedly tuning the offset.

Dev and release can diverge here: `pnpm tauri dev` reads the current frontend
through the dev server, while `/Applications/Tunara.app` and built `.app`
bundles run their embedded static frontend. Visual chrome changes should be
verified against the real bundle from `./node_modules/.bin/tauri build --bundles app`.
The dev app uses [`src-tauri/tauri.conf.dev.json`](../src-tauri/tauri.conf.dev.json)
with `productName: "Tuna"` and `identifier: "dev.tunara.app.dev"` so it can run
alongside the installed release app without macOS app-identity collisions.

The Rust side is a single library crate, [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs),
that wires up plugins, registers the IPC handlers, manages shared state, and runs
the event loop. Backend logic is split into modules under
[`src-tauri/src/modules/`](../src-tauri/src/modules/): `pty`, `ssh`, `fs`, `git`,
`agent`, `preview`, `resolver`, `editor`, `config`, `local_usage_log`,
`process`, `workspace_store`.

## IPC surface

Every command is registered in the `tauri::generate_handler!` block in
[`lib.rs`](../src-tauri/src/lib.rs). Frontend calls go through one `invoke()`
wrapper per module — the `*-bridge.ts` files — so the React components never type
a command string. The table below groups all registered commands by backend
module.

> Tauri serdes command args camelCase ↔ Rust snake_case automatically (so the
> Rust `repo_path` parameter is sent as `repoPath` from the bridge).

### `pty` — terminal sessions [`modules/pty`](../src-tauri/src/modules/pty/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `pty_open` | Spawn a local login shell over a PTY; returns physical id, streams `data`, `exit`, `connectionStatus`, and SSH-only prompt events on a `Channel<PtyEvent>` | `openPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_write` | Write input bytes to a session (local or SSH) | `PtySession.write`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_output_ack` | Acknowledge consumed output bytes so the backend can release its flow-control window | output buffer / SSH flow control via [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_resize` | Resize a session's PTY/SSH window | `PtySession.resize`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_close` | Kill/close a session and drop it from `PtyState` | `PtySession.close`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |

### `ssh` — remote sessions, host profiles, SFTP [`modules/ssh`](../src-tauri/src/modules/ssh/mod.rs)

SSH sessions reuse `pty_write` / `pty_resize` / `pty_close` (the `Session` enum
dispatches on `Local` vs `Ssh`), so only opening and SSH-specific concerns get
their own commands.

| Command | Does | Frontend caller |
|---|---|---|
| `ssh_open` | Legacy flat adapter: same handshake as `ssh_open_v2`, returns only the physical PTY id | kept for wire compatibility; current UI uses `ssh_open_v2` |
| `ssh_open_v2` | Open a russh interactive shell; returns physical id + backend-issued transport generation; same `Channel<PtyEvent>` contract as `pty_open` | `openSshPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_cancel_open` | Cancel an in-flight handshake/auth/shell-open attempt by generation id | `cancelSshOpen`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_host_key_decision` | Reply to a parked TOFU host-key prompt (accept/reject by `promptId`) | `answerHostKeyPrompt`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_keyboard_interactive_response` | Reply to a parked keyboard-interactive prompt by `promptId` | [`KeyboardInteractivePrompt.tsx`](../src/ui/overlays/KeyboardInteractivePrompt.tsx) via [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_diagnostic_run_v1` / `ssh_diagnostic_cancel_v1` | Run or cancel an explicit connection/config diagnostic | [`diagnostics-store.ts`](../src/modules/ssh/diagnostics-store.ts) |
| `ssh_local_forward_*` / `ssh_dynamic_forward_*` | Start, list, and stop local or dynamic (SOCKS) forwards | [`ForwardingPanel.tsx`](../src/modules/ssh/ForwardingPanel.tsx) |
| `ssh_forwarding_reconnect_snapshot` / `ssh_forwarding_reconnect_rebuild` | Snapshot forwarding intent across a reconnect, then rebuild | SSH reconnect path in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_hosts_load` | Read saved host profiles (no credentials) | `loadHosts`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_save` | Upsert a host profile, return the new list | `saveHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_remove` | Delete a host profile by id | `removeHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_import_config` | Import static host profiles from `~/.ssh/config` | `importSshConfig`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_known_hosts_list_v1` / `ssh_known_hosts_remove_v1` / `ssh_known_hosts_refresh_v1` | Inspect and prune the app known_hosts file | [`KnownHostsPanel.tsx`](../src/modules/ssh/KnownHostsPanel.tsx) |
| `ssh_fs_read_dir` | List a remote directory over SFTP | `sshReadDir`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_read_file` | Read a remote file over SFTP | `sshReadFile`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_file_view_head_v1` | Bounded remote text head (same limits as local `fs_file_view_head_v1`) | [`LIMITED_LARGE_FILE_VIEWING.md`](./LIMITED_LARGE_FILE_VIEWING.md) |
| `ssh_fs_write_text_file` | Conflict-checked, atomic remote text save | `sshWriteTextFile`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_reconcile_text_write` | Reconcile an outcome-unknown remote save after reconnect | `sshReconcileTextWrite`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_download` / `ssh_fs_upload` / `ssh_fs_cancel_upload` | Legacy single-file transfer adapters (unchanged wire names) | [`transfer-bridge.ts`](../src/modules/ssh/transfer-bridge.ts) |
| `ssh_transfer_download` / `ssh_transfer_upload` / `ssh_transfer_cancel` | Journaled transfers with progress channels | [`transfer-store.ts`](../src/modules/ssh/transfer-store.ts) |
| `validate_manifest` | Expand a local or remote folder into a bounded transfer manifest | [`transfer-bridge.ts`](../src/modules/ssh/transfer-bridge.ts) |
| `ssh_transfer_journal_*` / `ssh_transfer_recovery_*` | Persist, list, clean, and reconcile interrupted transfers | [`transfer_journal.rs`](../src-tauri/src/modules/ssh/transfer_journal.rs) |
| `ssh_fs_mutate_v1` / `ssh_fs_reconcile_mutation_v1` | Precondition-checked mkdir / rename / delete | [`remote-fs/bridge.ts`](../src/modules/ssh/remote-fs/bridge.ts) |
| `ssh_fs_stat_v1` / `ssh_fs_chmod_v1` | Remote metadata and chmod when the server supports it | [`RemoteMetadataPanel.tsx`](../src/modules/ssh/remote-fs/RemoteMetadataPanel.tsx) |
| `ssh_fs_home` | Resolve the remote home location (not the listing root) when no OSC 7 cwd is known | `sshHome`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_search` / `ssh_fs_grep` | Cancellable remote filename/content search over exec channels | `sshSearch` / `sshGrep`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_git_status` / `ssh_git_diff` / `ssh_git_ahead_behind` | Read-only remote Git inspection over exec channels | [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `ssh_git_workspace_context` | Read-only remote repository/common-dir/worktree discovery with the same shape as local discovery | [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |

### `fs` — local filesystem browsing, search, and safe writes [`modules/fs`](../src-tauri/src/modules/fs/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `fs_read_dir` | List a local directory | `fsReadDir`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_read_file` | Read a file (text/binary/image/too-large classified) | `fsReadFile`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_write_text_file` | Fingerprint-checked atomic text save | `fsWriteTextFile`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_file_view_head_v1` / `fs_cancel_file_view_v1` | Bounded first-N-line text view (local; SSH uses `ssh_file_view_head_v1`) | [`LIMITED_LARGE_FILE_VIEWING.md`](./LIMITED_LARGE_FILE_VIEWING.md) |
| `fs_search` | Fuzzy filename search under a root | `fsSearch`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_grep` | Content grep under a root | `fsGrep`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) (via [`FileExplorer.tsx`](../src/ui/FileExplorer.tsx)) |
| `fs_cancel_search` | Cancel the active local or remote search generation | `fsCancelGrep` / `cancelRemoteSearch` in the filesystem bridges |

### `git` — status / diff / watch [`modules/git`](../src-tauri/src/modules/git/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `git_status` | Branch + per-file change summary (cached, invalidated by the watcher) | `gitStatus`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_diff` | Per-file diff (text/binary/too-large/metadata) | `gitDiff`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_ahead_behind` | Upstream ahead/behind state | `gitAheadBehind`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_workspace_context` | Stable common-dir repository identity plus current and linked worktrees | `gitWorkspaceContext`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_watch` | Start (refcounted) a filesystem watcher on a repo | `gitWatch`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) (via [`git-watcher.ts`](../src/modules/git/git-watcher.ts)) |
| `git_unwatch` | Release one refcount on a repo's watcher | `gitUnwatch`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) (via [`git-watcher.ts`](../src/modules/git/git-watcher.ts)) |

### `resolver` — CLI path resolution [`modules/resolver`](../src-tauri/src/modules/resolver/mod.rs)

Resolves binaries (claude, codex, git, …) for GUI launches that don't inherit
the shell PATH.

| Command | Does | Frontend caller |
|---|---|---|
| `resolve_all_bins` | Resolve every agent CLI in the registry | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |
| `set_bin_override` | Store a user-specified absolute path override | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |
| `clear_bin_overrides` | Clear all user CLI path overrides | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |

### `agent` — agent CLI preflight [`modules/agent`](../src-tauri/src/modules/agent/preflight.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `agent_preflight` | Check whether an agent CLI is installed / logged in (cached) | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |
| `agent_preflight_invalidate` | Drop cached preflight results | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |

### `editor` — external editor jump [`modules/editor`](../src-tauri/src/modules/editor/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `open_in_editor` | Open `path` (optional line/column) in the configured editor | `openInEditor`, [`open.ts`](../src/modules/editor/open.ts) |

### `config` — text config file [`modules/config`](../src-tauri/src/modules/config.rs)

Reads/writes `~/.config/tunara/config.toml`, including the default-off local
usage logging preference.

| Command | Does | Frontend caller |
|---|---|---|
| `load_config` | Load appearance + keybindings config (with parse-error surfaced) | `loadTunaraConfig`, [`config-bridge.ts`](../src/modules/config/config-bridge.ts) |
| `save_config` | Write the config back to disk | `saveTunaraConfig`, [`config-bridge.ts`](../src/modules/config/config-bridge.ts) |

### `local_usage_log` — opt-in local SSH diagnostics [`modules/local_usage_log`](../src-tauri/src/modules/local_usage_log.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `local_usage_log_record` | Best-effort validation, anonymization, rotation, and JSONL append for one allowlisted event | `recordLocalUsageEvent`, [`local-usage-log.ts`](../src/modules/usage-log/local-usage-log.ts) |
| `local_usage_log_set_enabled` / `local_usage_log_status` | Atomically change native emission state or inspect location/capacity | Settings and UI config store via [`local-usage-log.ts`](../src/modules/usage-log/local-usage-log.ts) |
| `local_usage_log_ensure_directory` | Create the private local directory before revealing it in the file manager | Settings |
| `local_usage_log_export` / `local_usage_log_clear` | Manually export complete valid JSONL records or remove only managed log files | Settings |

The Rust writer is the final privacy boundary: event names, outcomes, error
categories, and attributes are allowlisted, while session/correlation values
are salted and hashed per app run. See [Local usage logging](LOCAL_USAGE_LOGGING.md).

### `preview` — tunneled preview webview windows [`modules/preview`](../src-tauri/src/modules/preview.rs)

Owns the secondary webview windows used to preview local/remote web apps and
static files. Manages lifecycle (open/close/refresh), viewport sizing, zoom,
capture, telemetry ingestion, and SSH-tunneled source access. State is held in
`PreviewWindowState` (managed when the Tauri builder is created).

| Command | Does | Frontend caller |
|---|---|---|
| `preview_open` | Open a preview window for a `PreviewSource` | `previewOpen`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_refresh` / `preview_close` | Refresh or close a preview window | `previewRefresh` / `previewClose`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_status` | Report the runtime state of a preview window | `previewStatus`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_navigate` | Navigate a preview window to a URL/path | `previewNavigate`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_go_back` / `preview_go_forward` | History navigation | `previewGoBack` / `previewGoForward`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_set_zoom` / `preview_reset_zoom` | Set or reset zoom factor | `previewSetZoom` / `previewResetZoom`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_set_viewport` / `preview_reset_viewport` / `preview_fit_viewport` | Set, reset, or auto-fit the viewport size | `previewSetViewport` / `previewResetViewport` / `previewFitViewport`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_telemetry_ingest` | Accept nonce-bound telemetry from an instrumented preview page | Injected telemetry bridge in [`preview.rs`](../src-tauri/src/modules/preview.rs) |
| `preview_telemetry_clear` / `preview_telemetry_send` | Clear captured failures or prepare them in the source terminal | `previewTelemetryClear` / `previewTelemetrySend`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_terminal_command_started` / `preview_terminal_command_finished` / `preview_terminal_exited` | Synchronize source-terminal lifecycle and command provenance | `previewTerminalCommandStarted` / `previewTerminalCommandFinished` / `previewTerminalExited`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_remote_source_observed` | Record a remote source before an explicit tunnel action | `previewRemoteSourceObserved`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_tunnel_open` / `preview_tunnel_status` / `preview_tunnel_close` | Open/status/close an SSH tunnel backing a remote preview | `previewTunnelOpen` / `previewTunnelStatus` / `previewTunnelClose`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_restart_prepare` | Prepare a proven failed source command in its terminal without executing it | `previewRestartPrepare`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_capture` | Capture a screenshot of the preview window | `previewCapture`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_send_capture_to_source_terminal` | Prepare a captured image reference in the source terminal without executing it | `previewSendCaptureToSourceTerminal`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |

### `workspace_store` — persistence health and legacy cleanup [`modules/workspace_store`](../src-tauri/src/modules/workspace_store.rs)

Reports whether the Tauri store plugin's session-persistence file
(`tunara-sessions.json`, legacy `conduit-sessions.json`) is present on disk, so
the frontend can distinguish a genuine first launch from a silently corrupted
store (the store plugin's first `load` swallows read/parse errors and returns
defaults). It also exposes a narrow compatibility path for explicitly deleting
the discontinued v1.16 Agent Event Store without exposing its payloads or a
caller-selected filesystem path.

| Command | Does | Frontend caller |
|---|---|---|
| `workspace_store_file_state` | Report `missing` or `present` for a known store file | [`persist.ts`](../src/state/persist.ts) |
| `legacy_agent_data_status` | Report whether fixed legacy `agent-events` data exists, without reading its contents | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |
| `legacy_agent_data_delete` | After explicit confirmation, delete only the fixed legacy directory; missing data is an idempotent success | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |

## The three transports

Data crosses the boundary three different ways. Picking the right one matters.

### 1. Request/response — `invoke()` via `*-bridge.ts`

The default. The frontend calls a typed wrapper in a `*-bridge.ts` file; that
wrapper calls `invoke("command_name", args)`; the Rust `#[tauri::command]`
returns `Result<T, String>` which resolves/rejects the promise. Everything in
the table above except the streaming `pty_open`/`ssh_open_v2` outputs works this way.

### 2. Per-session `Channel<PtyEvent>` — PTY + SSH output

Terminal output is too high-volume and too push-shaped for request/response, so
each session gets its own [`Channel`](https://v2.tauri.app/develop/calling-frontend/#channels).
The frontend creates a `Channel<PtyEvent>` and passes it as the `onEvent` arg to
`pty_open` / `ssh_open_v2`; the backend holds it and pushes events for the life of
the session.

`PtyEvent` is defined identically on both sides
([Rust](../src-tauri/src/modules/pty/session.rs),
[TS](../src/modules/terminal/lib/pty-bridge.ts)) — `#[serde(tag = "type", rename_all = "camelCase")]`:

| Variant | Payload | Meaning |
|---|---|---|
| `data` | `{ data: string }` | A chunk of terminal output, **base64-encoded** |
| `transportLost` | `{ reason: string }` | SSH only: the transport disappeared without a remote exit or a local close. `reason` is a stable machine-readable token, never a raw network error |
| `exit` | `{ code: number }` | The session ended (always the last event on the channel). SSH disconnects without `ExitStatus` use sentinel `-2` |
| `connectionStatus` | `{ phase: string }` | Fine-grained SSH open progress. Local PTYs keep opening/ready evidence on the renderer because spawn is synchronous |
| `hostKeyPrompt` | `{ promptId, host, port, fingerprint, keyType, reason }` | SSH only: an unknown (`reason: "unknown"`) or unverifiable (`"unverifiable"`) host key needs TOFU confirmation |
| `hostKeyPersistence` | `{ host, port, status }` | SSH only: whether accepting the key was saved, session-only, or durability-unknown |
| `keyboardInteractivePrompt` | `{ promptId, origin, name, instructions, prompts }` | SSH only: server-driven auth questions; the frontend replies with `ssh_keyboard_interactive_response` |

**Base64 encoding** ([`session.rs`](../src-tauri/src/modules/pty/session.rs)): a
Tauri `Channel<T>` serializes via JSON, where a raw `Vec<u8>` would become a JSON
int array (~3× larger). Output bytes are therefore base64-encoded on the Rust
side (`B64.encode`) and decoded in `decodeBase64()` in `pty-bridge.ts` before
being handed to xterm.js. The 33% base64 overhead is cheap on local IPC.

**Producer side** ([`session.rs`](../src-tauri/src/modules/pty/session.rs)): for
local sessions, a *reader* thread fills a pending buffer, a *flusher* thread
base64-encodes and `send`s a `data` event every 16 ms (`FLUSH_INTERVAL`), and a
*waiter* thread guarantees `exit` is sent last. Backpressure caps the buffer at
1 MiB (`MAX_PENDING`); on overflow the backlog is dropped and replaced with a
terminal-reset notice rather than slicing through an escape sequence.

**`hostKeyPrompt` flow**: on the SSH path, when a host key can't be verified the
backend emits `hostKeyPrompt` and *parks* the `ssh_open_v2` call inside the key
check. The frontend stashes the prompt in `useUIStore`, renders
`HostKeyPromptDialog`, and the user's decision flows back via the
`ssh_host_key_decision` command (transport #1), which unparks the open.
`reason: "unknown"` may persist into known_hosts; `reason: "unverifiable"`
never does. Keyboard-interactive auth uses the same park/unpark pattern with
`keyboardInteractivePrompt` / `ssh_keyboard_interactive_response`.

### 3. Global broadcast — `listen()` events

For backend-originated notifications with no single waiting caller, the backend
`emit`s a named event and the frontend subscribes with `listen()`. There are two.

#### `git-changed`

- **Emitter**: the debounced filesystem watcher in
  [`git/watcher.rs`](../src-tauri/src/modules/git/watcher.rs) (`app.emit("git-changed", …)`),
  fired ~300 ms after a non-noisy change in a watched repo. It also invalidates
  cached `git_status` and workspace/worktree discovery before emitting.
- **Listener**: `startGitWatcherListener()` in
  [`git-watcher.ts`](../src/modules/git/git-watcher.ts). For every session whose
  `dir` matches the changed repo, it calls `refreshGit(session.id)`.
- **Payload**: `{ repoPath: string }` (Rust serializes `repo_path` as `repoPath`).

#### `agent-hook`

- **Emitter**: the per-process Unix-socket hook listener in
  [`agent/hooks.rs`](../src-tauri/src/modules/agent/hooks.rs)
  (`app.emit("agent-hook", …)`). The injected shell integration writes a small
  JSON payload to the socket when an agent CLI starts/stops; the listener thread
  parses it and re-emits it as an app event.
- **Listener**: `startHooksListener()` in
  [`hooks-listener.ts`](../src/modules/terminal/lib/hooks-listener.ts). Routes to
  `handleAgentDetected` / `handleAgentReady` / `handleAgentExited` on the
  sessions store based on the `event` field.
- **Payload**: `{ event: string, session: string, agent?: string | null, code?: number | null }`.
  `event` is one of `start` / `stop` / `idle` / `exit`.

## Managed state

`lib.rs` registers eight shared state objects. Six are `.manage()`d at builder
time; two are created in `.setup()` because they need resolved app paths or the
`AppHandle`. All are
retrieved in commands via `tauri::State<'_, T>`. Transfer journals are
file-backed (initialized in `.setup()` via `transfer_journal::initialize`)
rather than a ninth managed object. Bounded file-view cancellation uses a
process-wide table inside [`fs/head.rs`](../src-tauri/src/modules/fs/head.rs).

| State | Holds | Lifecycle |
|---|---|---|
| [`PtyState`](../src-tauri/src/modules/pty/mod.rs) | All live sessions: `HashMap<u32, Arc<Session>>` (physical id → session), a `logical_id → physical_id` map for reopen/replace, and a monotonic `next_id` (starts at 1, never reused) | `.manage(PtyState::default())`; `close_all()` on `RunEvent::Exit` kills every session |
| [`ForwardingState`](../src-tauri/src/modules/ssh/forwarding.rs) | Active SSH local-forward listeners and their cancellation handles | `.manage(ForwardingState::default())`; forward commands create and close entries |
| [`FsSearchCancellationState`](../src-tauri/src/modules/fs/grep.rs) | Pending, pre-cancelled, and recently finished filesystem-search request IDs | `.manage(FsSearchCancellationState::default())`; each request unregisters itself on completion |
| [`ResolverState`](../src-tauri/src/modules/resolver/mod.rs) | User path overrides + the login-shell PATH dirs probed at startup | `.manage(ResolverState::default())`; `init_login_path()` called early in `.setup()` so `resolve_all_bins` works for GUI launches |
| [`PreviewWindowState`](../src-tauri/src/modules/preview.rs) | Preview window generations, source/runtime status, tunnels, captures, and restart provenance | `.manage(PreviewWindowState::default())`; all tunnels close on `RunEvent::Exit` |
| [`GitWatcherState`](../src-tauri/src/modules/git/watcher.rs) | Refcounted per-repo filesystem debouncers + the `git_status` result cache | `.manage(GitWatcherState::default())`; entries created by `git_watch`, removed at refcount 0 by `git_unwatch` |
| [`LocalUsageLogState`](../src-tauri/src/modules/local_usage_log.rs) | Default-off emission state, per-run anonymous-ID salt, active JSONL file, sequence, and rotation limits behind one mutex | Created fail-closed and `app.manage()`d in `.setup()` after resolving the native app log directory; disk failures never block startup or SSH flows |
| [`HookListenerState`](../src-tauri/src/modules/agent/hooks.rs) | The agent-hook Unix socket path + a shutdown flag for its listener thread | Created by `start_listener(app.handle())` and `app.manage()`d in `.setup()`; `shutdown()` (removes the socket, stops the thread) on `RunEvent::Exit` |

Teardown lives in the `RunEvent::Exit` arm of the `.run(|app, event| …)` closure
in [`lib.rs`](../src-tauri/src/lib.rs):

```rust
tauri::RunEvent::Exit => {
    app.state::<ForwardingState>().close_all();
    app.state::<PreviewWindowState>().close_all_tunnels(app);
    app.state::<pty::PtyState>().close_all();
    app.state::<HookListenerState>().shutdown();
}
```

## Startup order

`useInit()` ([`src/app/useInit.ts`](../src/app/useInit.ts)) runs once on mount
(guarded by `initRef`). The sequence:

1. **`loadUserConfig()`** — load `config.toml` (appearance + keybindings) into
   the UI store.
2. **`loadWorkspaceSnapshot()`** — restore the persisted workspace: sessions,
   active session, UI layout (sidebar/panel/split/inspector), terminal
   scrollback snapshots, agent-resume data, recent dirs/commands, workflows.
   Split layout is a recursive tree capped at four panes
   ([`split-layout.ts`](../src/modules/session/split-layout.ts)).
   If no snapshot exists, seed a single `~` terminal. Sets `ui.ready = true`,
   which flips `App` from the splash screen to the shell.
3. **Window wiring** — read `platform()`, size the macOS traffic-light inset,
   subscribe to fullscreen/resize, and register `onCloseRequested` to persist a
   final snapshot and hide the window.
4. **`startHooksListener()` + `startGitWatcherListener()`** — subscribe to the
   `agent-hook` and `git-changed` global events (transport #3). Their unlisten
   functions are collected for cleanup.
5. **Initial `syncGitWatches(...)`** — diff the current sessions' (normalized)
   directories against the empty watched set and `acquireGitWatch` each one,
   establishing the first batch of backend watchers. From then on a sessions-store
   subscription re-runs `syncGitWatches` on every session change to acquire/release
   watchers as sessions come and go.

The cleanup function returned from the effect unsubscribes the store listeners,
flushes a final snapshot, clears the periodic save timer, releases every git
watch, and calls each collected unlisten function.
