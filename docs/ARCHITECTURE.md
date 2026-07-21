# Architecture

How the React frontend and the Rust (Tauri 2) backend fit together, and where
to look when you need to change something. This is a map of the boundary, not a
feature list — for what Tunara *is*, see the [README](../README.md).

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
  list grouped by working directory, plus a derived attention/running/recovery
  layer for SSH, commands, and agents.
- **Center — `MainArea`** ([`src/ui/MainArea.tsx`](../src/ui/MainArea.tsx) →
  [`TerminalView`](../src/ui/TerminalView.tsx)): the actual terminals. xterm.js +
  WebGL, one per session, optionally split into two panes.
- **Right: `InspectorPanel`** ([`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx)):
  overview, read-only git diff ([`DiffPanel`](../src/ui/DiffPanel.tsx)),
  read-only file tree ([`FileExplorer`](../src/ui/FileExplorer.tsx) /
  [`FilePreview`](../src/ui/FilePreview.tsx)), and session notes.

Both side panes collapse to width `0` and switch to floating overlays below
viewport breakpoints (720px for the sidebar, 900px for the panel). Overlays
(`Settings`, `CommandPalette`, `SshConnect`, `HostKeyPromptDialog`,
`WorkflowParamPrompt`, `ToastContainer`) are rendered as siblings, gated on
`useUIStore`. State lives in Zustand stores under [`src/state/`](../src/state/)
(`sessions`, `ui`, `workflows`, `persist`).

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
`agent`, `agent_event_store`, `preview`, `resolver`, `editor`, `config`,
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
| `pty_open` | Spawn a local login shell over a PTY; returns physical id, streams `data`, `exit`, and `connectionStatus` events on a `Channel<PtyEvent>` | `openPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_write` | Write input bytes to a session (local or SSH) | `PtySession.write`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_resize` | Resize a session's PTY/SSH window | `PtySession.resize`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_close` | Kill/close a session and drop it from `PtyState` | `PtySession.close`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |

### `ssh` — remote sessions, host profiles, SFTP [`modules/ssh`](../src-tauri/src/modules/ssh/mod.rs)

SSH sessions reuse `pty_write` / `pty_resize` / `pty_close` (the `Session` enum
dispatches on `Local` vs `Ssh`), so only opening and SSH-specific concerns get
their own commands.

| Command | Does | Frontend caller |
|---|---|---|
| `ssh_open` | Open a russh interactive shell; same `Channel<PtyEvent>` contract as `pty_open`, with backend `connectionStatus` phases plus the `hostKeyPrompt` variant | `openSshPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_cancel_open` | Cancel an in-flight handshake/auth/shell-open attempt by generation id | `cancelSshOpen`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_host_key_decision` | Reply to a parked TOFU host-key prompt (accept/reject by `promptId`) | `answerHostKeyPrompt`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_hosts_load` | Read saved host profiles (no credentials) | `loadHosts`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_save` | Upsert a host profile, return the new list | `saveHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_remove` | Delete a host profile by id | `removeHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_import_config` | Import static host profiles from `~/.ssh/config` | `importSshConfig`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_fs_read_dir` | List a remote directory over SFTP | `sshReadDir`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_read_file` | Read a remote file over SFTP | `sshReadFile`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_download` | Download a remote file to a local path, return bytes written | `sshDownload`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_home` | Resolve the remote home dir when no OSC 7 absolute cwd is known | `sshHome`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_search` / `ssh_fs_grep` | Cancellable remote filename/content search over exec channels | `sshSearch` / `sshGrep`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_git_status` / `ssh_git_diff` / `ssh_git_ahead_behind` | Read-only remote Git inspection over exec channels | [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `ssh_git_workspace_context` | Read-only remote repository/common-dir/worktree discovery with the same shape as local discovery | [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |

### `fs` — local filesystem (read-only) [`modules/fs`](../src-tauri/src/modules/fs/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `fs_read_dir` | List a local directory | `fsReadDir`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_read_file` | Read a file (text/binary/too-large classified) | `fsReadFile`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
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

Reads/writes `~/.config/tunara/config.toml`.

| Command | Does | Frontend caller |
|---|---|---|
| `load_config` | Load appearance + keybindings config (with parse-error surfaced) | `loadTunaraConfig`, [`config-bridge.ts`](../src/modules/config/config-bridge.ts) |
| `save_config` | Write the config back to disk | `saveTunaraConfig`, [`config-bridge.ts`](../src/modules/config/config-bridge.ts) |

### `agent_event_store` — append-only local Agent event journal [`modules/agent_event_store`](../src-tauri/src/modules/agent_event_store.rs)

Stores Agent lifecycle events (status, tool calls, output summaries, file
changes, etc.) in a bounded on-disk journal with per-event private payloads
and a search index. Capped at `MAX_EVENT_COUNT` (100k) / `MAX_PAYLOAD_TOTAL_BYTES`
(256 MiB); older events are pruned.

| Command | Does | Frontend caller |
|---|---|---|
| `agent_event_store_status` | Report enabled/disabled + capability state | `agentEventStoreStatus`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_store_set_enabled` | Enable/disable the store at runtime | `setAgentEventStoreEnabled`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_append` | Append an event + optional private payload to the journal | `appendAgentEvent`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_list` | List event headers with paging | `listAgentEvents`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_payload` | Read a single event's private payload (provenance-checked) | `readAgentEventPayload`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_search_status` | Report search index capability state | `agentEventSearchStatus`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_search` | Query the search index by scope/kind/kind/text | `searchAgentEvents`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_search_rebuild` | Rebuild the search index from the journal | `rebuildAgentEventSearch`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |
| `agent_event_delete` | Delete events for a task/source | `deleteAgentEvents`, [`agent-event-bridge.ts`](../src/modules/agent-events/agent-event-bridge.ts) |

### `preview` — tunneled preview webview windows [`modules/preview`](../src-tauri/src/modules/preview.rs)

Owns the secondary webview windows used to preview local/remote web apps and
static files. Manages lifecycle (open/close/refresh), viewport sizing, zoom,
capture, telemetry ingestion, and SSH-tunneled source access. State is held in
`PreviewWindowState` (managed in `.setup()`).

| Command | Does | Frontend caller |
|---|---|---|
| `preview_open` | Open a preview window for a `PreviewSource` | `previewOpen`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_status` | Report the runtime state of a preview window | `previewStatus`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_navigate` | Navigate a preview window to a URL/path | `previewNavigate`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_go_back` / `preview_go_forward` | History navigation | `previewGoBack` / `previewGoForward`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_set_zoom` / `preview_reset_zoom` | Set or reset zoom factor | `previewSetZoom` / `previewResetZoom`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_set_viewport` / `preview_reset_viewport` / `preview_fit_viewport` | Set, reset, or auto-fit the viewport size | `previewSetViewport` / `previewResetViewport` / `previewFitViewport`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_capture` | Capture a screenshot of the preview window | `previewCapture`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_close` | Close a preview window | `previewClose`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |
| `preview_tunnel_open` / `preview_tunnel_status` / `preview_tunnel_close` | Open/status/close an SSH tunnel backing a remote preview | `previewTunnelOpen` / `previewTunnelStatus` / `previewTunnelClose`, [`preview-window.ts`](../src/modules/preview/preview-window.ts) |

### `workspace_store` — session persistence store health [`modules/workspace_store`](../src-tauri/src/modules/workspace_store.rs)

Reports whether the Tauri store plugin's session-persistence file
(`tunara-sessions.json`, legacy `conduit-sessions.json`) is present on disk, so
the frontend can distinguish a genuine first launch from a silently corrupted
store (the store plugin's first `load` swallows read/parse errors and returns
defaults).

| Command | Does | Frontend caller |
|---|---|---|
| `workspace_store_file_state` | Report `missing` or `present` for a known store file | `loadWorkspaceStoreFileState`, [`persist.ts`](../src/state/persist.ts) |

## The three transports

Data crosses the boundary three different ways. Picking the right one matters.

### 1. Request/response — `invoke()` via `*-bridge.ts`

The default. The frontend calls a typed wrapper in a `*-bridge.ts` file; that
wrapper calls `invoke("command_name", args)`; the Rust `#[tauri::command]`
returns `Result<T, String>` which resolves/rejects the promise. Everything in
the table above except the streaming `pty_open`/`ssh_open` outputs works this way.

### 2. Per-session `Channel<PtyEvent>` — PTY + SSH output

Terminal output is too high-volume and too push-shaped for request/response, so
each session gets its own [`Channel`](https://v2.tauri.app/develop/calling-frontend/#channels).
The frontend creates a `Channel<PtyEvent>` and passes it as the `onEvent` arg to
`pty_open` / `ssh_open`; the backend holds it and pushes events for the life of
the session.

`PtyEvent` is defined identically on both sides
([Rust](../src-tauri/src/modules/pty/session.rs),
[TS](../src/modules/terminal/lib/pty-bridge.ts)) — `#[serde(tag = "type", rename_all = "camelCase")]`:

| Variant | Payload | Meaning |
|---|---|---|
| `data` | `{ data: string }` | A chunk of terminal output, **base64-encoded** |
| `exit` | `{ code: number }` | The session ended (always the last event on the channel) |
| `hostKeyPrompt` | `{ promptId, host, port, fingerprint, keyType }` | SSH only: an unknown host key needs TOFU confirmation |

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
backend emits `hostKeyPrompt` and *parks* the `ssh_open` call inside the key
check. The frontend stashes the prompt in `useUIStore`, renders
`HostKeyPromptDialog`, and the user's decision flows back via the
`ssh_host_key_decision` command (transport #1), which unparks `ssh_open`.

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

`lib.rs` registers four shared state objects. Three are `.manage()`d at builder
time; one is created in `.setup()` because it needs the `AppHandle`. All are
retrieved in commands via `tauri::State<'_, T>`.

| State | Holds | Lifecycle |
|---|---|---|
| [`PtyState`](../src-tauri/src/modules/pty/mod.rs) | All live sessions: `HashMap<u32, Arc<Session>>` (physical id → session), a `logical_id → physical_id` map for reopen/replace, and a monotonic `next_id` (starts at 1, never reused) | `.manage(PtyState::default())`; `close_all()` on `RunEvent::Exit` kills every session |
| [`ResolverState`](../src-tauri/src/modules/resolver/mod.rs) | User path overrides + the login-shell PATH dirs probed at startup | `.manage(ResolverState::default())`; `init_login_path()` called early in `.setup()` so `resolve_all_bins` works for GUI launches |
| [`GitWatcherState`](../src-tauri/src/modules/git/watcher.rs) | Refcounted per-repo filesystem debouncers + the `git_status` result cache | `.manage(GitWatcherState::default())`; entries created by `git_watch`, removed at refcount 0 by `git_unwatch` |
| [`HookListenerState`](../src-tauri/src/modules/agent/hooks.rs) | The agent-hook Unix socket path + a shutdown flag for its listener thread | Created by `start_listener(app.handle())` and `app.manage()`d in `.setup()`; `shutdown()` (removes the socket, stops the thread) on `RunEvent::Exit` |

Teardown lives in the `RunEvent::Exit` arm of the `.run(|app, event| …)` closure
in [`lib.rs`](../src-tauri/src/lib.rs):

```rust
tauri::RunEvent::Exit => {
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
