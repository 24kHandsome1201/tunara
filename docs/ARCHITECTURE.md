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
  list grouped by working directory, with live agent status.
- **Center — `MainArea`** ([`src/ui/MainArea.tsx`](../src/ui/MainArea.tsx) →
  [`TerminalView`](../src/ui/TerminalView.tsx)): the actual terminals. xterm.js +
  WebGL, one per session, optionally split into two panes.
- **Right — `InspectorPanel`** ([`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx)):
  the review rail — git diff ([`DiffPanel`](../src/ui/DiffPanel.tsx)) and a
  read-only file tree ([`FileExplorer`](../src/ui/FileExplorer.tsx) /
  [`FilePreview`](../src/ui/FilePreview.tsx)).

Both side panes collapse to width `0` and switch to floating overlays below
viewport breakpoints (720px for the sidebar, 900px for the panel). Overlays
(`Settings`, `CommandPalette`, `SshConnect`, `HostKeyPromptDialog`,
`WorkflowParamPrompt`, `ToastContainer`) are rendered as siblings, gated on
`useUIStore`. State lives in Zustand stores under [`src/state/`](../src/state/)
(`sessions`, `ui`, `workflows`, `persist`).

The Rust side is a single library crate, [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs),
that wires up plugins, registers the IPC handlers, manages shared state, and runs
the event loop. Backend logic is split into modules under
[`src-tauri/src/modules/`](../src-tauri/src/modules/): `pty`, `ssh`, `fs`, `git`,
`agent`, `resolver`, `editor`, `config`, `process`.

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
| `pty_open` | Spawn a local login shell over a PTY; returns physical id, streams output on a `Channel<PtyEvent>` | `openPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_write` | Write input bytes to a session (local or SSH) | `PtySession.write`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_resize` | Resize a session's PTY/SSH window | `PtySession.resize`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `pty_close` | Kill/close a session and drop it from `PtyState` | `PtySession.close`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |

### `ssh` — remote sessions, host profiles, SFTP [`modules/ssh`](../src-tauri/src/modules/ssh/mod.rs)

SSH sessions reuse `pty_write` / `pty_resize` / `pty_close` (the `Session` enum
dispatches on `Local` vs `Ssh`), so only opening and SSH-specific concerns get
their own commands.

| Command | Does | Frontend caller |
|---|---|---|
| `ssh_open` | Open a russh interactive shell; same `Channel<PtyEvent>` contract as `pty_open`, plus the `hostKeyPrompt` variant | `openSshPty` in [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_host_key_decision` | Reply to a parked TOFU host-key prompt (accept/reject by `promptId`) | `answerHostKeyPrompt`, [`pty-bridge.ts`](../src/modules/terminal/lib/pty-bridge.ts) |
| `ssh_hosts_load` | Read saved host profiles (no credentials) | `loadHosts`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_save` | Upsert a host profile, return the new list | `saveHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_hosts_remove` | Delete a host profile by id | `removeHost`, [`hosts-bridge.ts`](../src/modules/ssh/hosts-bridge.ts) |
| `ssh_fs_read_dir` | List a remote directory over SFTP | `sshReadDir`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_read_file` | Read a remote file over SFTP | `sshReadFile`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_download` | Download a remote file to a local path, return bytes written | `sshDownload`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |
| `ssh_fs_home` | Resolve the remote home dir (initial path for the file panel) | `sshHome`, [`remote-fs-bridge.ts`](../src/modules/ssh/remote-fs-bridge.ts) |

### `fs` — local filesystem (read-only) [`modules/fs`](../src-tauri/src/modules/fs/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `fs_read_dir` | List a local directory | `fsReadDir`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_read_file` | Read a file (text/binary/too-large classified) | `fsReadFile`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `fs_search` | Fuzzy filename search under a root | `fsSearch`, [`fs-bridge.ts`](../src/modules/fs/fs-bridge.ts) |
| `list_subdirs` | List immediate subdirectory names | _registered; no current frontend caller_ |
| `fs_stat` | `lstat` a path (`FileStat`) | _registered; no current frontend caller_ |
| `fs_grep` | Content grep under a root | _registered; no current frontend caller_ |
| `fs_glob` | Glob match under a root | _registered; no current frontend caller_ |

### `git` — status / diff / watch [`modules/git`](../src-tauri/src/modules/git/mod.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `git_status` | Branch + per-file change summary (cached, invalidated by the watcher) | `gitStatus`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_diff` | Per-file diff (text/binary/too-large/metadata) | `gitDiff`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_ahead_behind` | Upstream ahead/behind state | `gitAheadBehind`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) |
| `git_watch` | Start (refcounted) a filesystem watcher on a repo | `gitWatch`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) (via [`git-watcher.ts`](../src/modules/git/git-watcher.ts)) |
| `git_unwatch` | Release one refcount on a repo's watcher | `gitUnwatch`, [`git-bridge.ts`](../src/modules/git/git-bridge.ts) (via [`git-watcher.ts`](../src/modules/git/git-watcher.ts)) |

### `resolver` — CLI path resolution [`modules/resolver`](../src-tauri/src/modules/resolver/mod.rs)

Resolves binaries (claude, codex, git, …) for GUI launches that don't inherit
the shell PATH.

| Command | Does | Frontend caller |
|---|---|---|
| `resolve_all_bins` | Resolve every agent CLI in the registry | [`Settings.tsx`](../src/ui/overlays/Settings.tsx) |
| `resolve_bin` | Resolve one binary by name | _registered; no current frontend caller_ |
| `set_bin_override` | Store a user-specified absolute path override | _registered; no current frontend caller_ |

### `agent` — agent CLI preflight [`modules/agent`](../src-tauri/src/modules/agent/preflight.rs)

| Command | Does | Frontend caller |
|---|---|---|
| `agent_preflight` | Check whether an agent CLI is installed / logged in (cached) | _registered; no current frontend caller_ |
| `agent_preflight_invalidate` | Drop cached preflight results | _registered; no current frontend caller_ |

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
  the cached `git_status` for that repo first.
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
| [`ResolverState`](../src-tauri/src/modules/resolver/mod.rs) | User path overrides + the login-shell PATH dirs probed at startup | `.manage(ResolverState::default())`; `init_login_path()` called early in `.setup()` so `resolve_bin` works for GUI launches |
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
