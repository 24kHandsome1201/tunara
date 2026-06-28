# State & Persistence

Tunara keeps all renderer state in two Zustand stores and persists a single
versioned workspace snapshot to a Tauri plugin-store file. This doc covers the
store split, what gets persisted vs. what is ephemeral, the save/restore
lifecycle, the legacy `conduit-*` migration, and the sanitizers that defend the
restore path against corrupt or outdated data.

| File | Role |
| --- | --- |
| `src/state/sessions.ts` | Central store: session list, active session, agent-hook + lifecycle handlers, git refresh nonce |
| `src/state/ui.ts` | Layout / appearance prefs / toasts / SSH host-key prompt; loads & writes the user config |
| `src/state/persist.ts` | Plugin-store I/O, legacy migration, and save/load entry points |
| `src/state/persist-snapshot.ts` | `WorkspaceSnapshotV1` shape, durable-session helpers, and pure snapshot sanitizers |
| `src/state/workflows.ts` | Command-template workflows store |
| `src/state/recent-commands.ts` | `pushRecentCommand` / `sanitizeRecentCommands` (pure helpers) |
| `src/state/recent-dirs.ts` | `pushRecentDir` / `sanitizeRecentDirs` (pure helpers) |
| `src/app/useInit.ts` | Wires it all together: restore on mount, debounced + interval + on-close save |

## 1. The two Zustand stores

### `useSessionsStore` (`src/state/sessions.ts`)

The central store. Key state fields:

```
sessions: Session[]                       // the full session list (Session = src/ui/types.ts)
activeSessionId: string | null
renamingSessionId: string | null          // session whose tab is being inline-renamed
launchedSessionIds: Record<string, true>  // which sessions have ever been the active/visible PTY
gitNonce: Record<string, number>          // bump to trigger a git re-read for a session
closeConfirmations: Record<string, number>     // "press close again" timestamps for busy sessions
dirCloseConfirmations: Record<string, number>  // same, for "close all in dir"
recentDirs: string[]                      // hydrated from the snapshot on init
recentCommands: string[]                  // hydrated from the snapshot on init
```

`Session` itself (defined in `src/ui/types.ts`) carries both persisted fields
(`id`, `title`, `dir`, `branch`, `customTitle`, `remote`, `updatedAt`) and a
large set of live/ephemeral fields — `runState`, `agentActivity`,
`agentResume`, `lastCommand`, `lastExitCode`, `shellTitle`, `terminalProgress`,
`gitState`, `changes`, `ptyId`, `pendingInput*`, `unread`. See §2 for which are
saved.

**Agent-hook handlers.** These mutate session state in response to the
`agent-hook` Tauri event (the only agent-driven event channel), dispatched by
`startHooksListener()` in `src/modules/terminal/lib/hooks-listener.ts`:

| `agent-hook` payload `event` | Store handler | Effect |
| --- | --- | --- |
| `"start"` (with `agent`) | `handleAgentDetected(id, agent)` | mark agent present, build `agentResume` intent |
| `"exit"` | `handleAgentExited(id, code)` | clear agent state, refresh git, toast if backgrounded |
| `"stop"` / `"idle"` | `handleAgentReady(id)` | agent turn complete, refresh git, toast if backgrounded |

The listener guards each transition against the session's current `agent` so a
stale event for a different agent is ignored. `handleAgentDetected` also derives
an `AgentResumeIntent` (via `buildAgentResumeIntent`) by scanning the command
for `--resume <id>` / `--continue`, used later to re-launch the agent.

**Other lifecycle handlers** (`handleAgentBusy`, `handleCommandDetected`,
`handleCommandFinished`, `handleCwdChange`, `handleShellTitle`,
`handleTerminalProgress`) are *not* driven by Tauri event channels — they are
called from the terminal data stream (OSC / shell-integration parsing) in
`src/ui/TerminalView.tsx`. Each delegates the pure transition to
`src/modules/terminal/lib/session-lifecycle.ts` and applies the returned patch
via `updateSession`. `handleCwdChange` additionally records the dir into
`recentDirs` (skipped for remote sessions, whose `dir` is `user@host`).

**`refreshGit(id)`.** Bumps `gitNonce[id]` to signal a git re-read for that
session's working tree. It is throttled (`GIT_REFRESH_THROTTLE_MS = 1500`) and
short-circuits for remote SSH sessions (no local working tree). Git change data
flows back in through the separate `git-changed` Tauri event
(`src/modules/git/git-watcher.ts`).

### `useUIStore` (`src/state/ui.ts`)

Layout, appearance preferences, transient UI, and the SSH host-key prompt. It
extends `AppearanceSettings` (theme/accent/font/scrollback/keybindings/language/
etc.) and adds:

```
ready: boolean                       // set true once useInit finishes restore
configLoaded / configPath / configError  // user-config load status
sidebarVisible / panelVisible
overlay: OverlayType                 // null | "settings" | "command-palette" | "ssh"
split: SplitState                    // { mode, paneA, paneB, ratio }
inspectorTab: "changes" | "files"
toasts: Toast[]                      // capped, last 3
hostKeyPrompt: HostKeyPrompt | null  // pending SSH TOFU confirmation
pendingWorkflow: PendingWorkflow | null
collapsedDirs: Record<string, true>
collapsedDiffSections: Record<string, true>
commandUsage: Record<string, number> // command-palette recency, capped at 50
trafficLightWidth / viewportWidth    // runtime layout, not persisted
```

`hostKeyPrompt` is set by the PTY bridge (`setHostKeyPrompt` is called from
`src/modules/terminal/lib/pty-bridge.ts`) when the backend `ssh_open` call
parks on an unknown host key; the overlay in `src/ui/overlays/HostKeyPrompt.tsx`
resolves it.

**Two distinct persistence channels for the UI store:**

1. **User config** (`loadUserConfig` / the appearance subscriber): the
   `AppearanceSettings` half (theme, accent, fonts, scrollback, sidebar/panel
   width, terminal theme, external editor, bell, clipboard/inline-image flags,
   keybindings, language) is loaded via `loadUserConfig()` and written through
   `src/modules/config/config-bridge.ts` to the backend config file. A
   `subscribeWithSelector` subscription over `PERSIST_KEYS` debounces saves at
   300 ms and is suppressed during hydration (the `configHydrating` flag) and
   until `configLoaded` is true.
2. **Workspace snapshot** (see §2): layout fields — `sidebarVisible`,
   `panelVisible`, `collapsedDirs`, `collapsedDiffSections`, `split`,
   `inspectorTab`, `commandUsage` —
   are persisted into the snapshot file, *not* the config file. `useInit`
   subscribes to those keys and triggers a snapshot save.

## 2. Persistence layer (`src/state/persist.ts`)

### `WorkspaceSnapshotV1`

The single source of truth on disk:

```ts
interface WorkspaceSnapshotV1 {
  version: 1;
  savedAt: number;
  activeSessionId: string | null;
  sessions: PersistedSessionV2[];
  ui: PersistedUILayoutV2;                          // sidebar/panel/collapsedDirs/collapsedDiffSections/split/inspectorTab
  terminals: Record<string, PersistedTerminalSnapshot>;  // serialized xterm buffers, keyed by session id
  agentResume: Record<string, PersistedAgentResumeIntent>;
  recentDirs: string[];
  recentCommands: string[];
  commandUsage: Record<string, number>;            // palette recency
  workflows: Workflow[];                            // user command templates
}
```

### Persisted vs. ephemeral session fields

Only a narrow slice of `Session` is written. `PersistedSession` is a `Pick`:

```ts
type PersistedSession = Pick<Session, "id" | "title" | "dir" | "branch" | "updatedAt">
  & { customTitle?: string; remote?: Session["remote"]; pinned?: boolean; note?: string };
```

So the persisted fields are: **`id`, `title`, `dir`, `branch`, `updatedAt`,
`customTitle` (only if set), `remote` (only if set), `pinned` (only when true),
and sanitized `note` (only if non-empty)**.

Everything else on `Session` is **ephemeral** and recomputed live after
restart, including `runState` (forced back to `"idle"` on restore via
`fromPersistedSession` / `useInit`), `agentActivity`, `lastCommand`,
`lastExitCode`, `shellTitle`, `terminalProgress`, `gitState`, `changes`,
`ptyId`, `unread`, and `pendingInput*`. `agentResume` is the one exception: it
is *not* part of `PersistedSession` but is persisted **separately** in the
snapshot's top-level `agentResume` map (keyed by session id) and re-attached to
the session on restore.

`remote` carries only the SSH connection descriptor (host/port/user/identity
path) — **no secrets**. `persist-snapshot.ts` sanitizes it by white-listing
those fields only; one-shot passwords, key passphrases, and host-key decisions
stay out of the snapshot. The connection is re-opened lazily when the terminal
mounts. A stored session with a malformed `remote` descriptor is dropped during
restore instead of being converted into a misleading local session.

### When it saves

Saving is orchestrated in `src/app/useInit.ts` against
`saveWorkspaceSnapshot(buildSnapshot())`:

- **Debounced (500 ms)** — `scheduleSave()` fires on any change to the sessions
  list, to the watched UI-store keys (`collapsedDirs`, `collapsedDiffSections`,
  `split`, `inspectorTab`, `sidebarVisible`, `panelVisible`, `commandUsage`), or
  to the workflows list.
- **On window close** — `win.onCloseRequested` preempts the close, flushes any
  pending debounce, awaits a synchronous final save, then hides the window.
- **On an interval** — the 30 s backstop checks
  `consumeTerminalSnapshotDirty()` and only flushes when terminal scrollback has
  changed since the last save.
- **On unmount** — the effect cleanup flushes a pending save if one is queued.

(Note: the appearance half of the UI store is saved on its own 300 ms debounce
to the config file, independently of the snapshot — see §1.)

### When it restores

`useInit` calls `loadWorkspaceSnapshot()` once on mount (guarded by a ref so it
runs a single time). On success it rebuilds `Session` objects from the persisted
slice (re-attaching `agentResume`, forcing `runState: "idle"`), merges them with
any sessions already created this run, re-derives `activeSessionId`, restores
the `split`/layout/`commandUsage` into the UI store, loads `workflows`, and
restores terminal buffers via `restoreTerminalSnapshots`. When no snapshot
exists it seeds a single `~` terminal. `ready` is flipped to `true` at the end.

There are also standalone `loadSessions` / `saveSessions` / `loadUILayout` /
`saveUILayout` helpers for the legacy `sessions` / `activeSessionId` /
`uiLayout` keys. `saveSessions` and `saveUILayout` update the workspace snapshot
when those helper paths are used, but the normal `useInit` runtime save path
writes the workspace snapshot directly; it does not continuously mirror the
legacy keys. The snapshot is the primary path used by `useInit`.

## 3. Store file naming & the conduit → tunara migration

The plugin-store file is named in `persist.ts`:

```ts
const STORE_FILE        = "tunara-sessions.json";
const LEGACY_STORE_FILE = "conduit-sessions.json";
```

`loadSessionStore()` implements the migration: it opens `tunara-sessions.json`;
if that store is empty it opens the legacy `conduit-sessions.json`, copies every
entry across into the new store, saves, and returns the new store. The migration
is one-way and lazy — it only runs while the new store is still empty, so once
Tunara has written anything the legacy file is never read again.

> The project name changed from **Conduit** to **Tunara**; this fallback is the
> upgrade bridge for users who persisted state under the old name.

## 4. Sanitizers (defending the restore path)

Persisted JSON is untrusted input: it may be from an older schema, hand-edited,
or partially corrupted. Every value read back is run through a sanitizer that
returns a known-good shape (or drops the item) rather than trusting it.

| Sanitizer | Location | What it guards |
| --- | --- | --- |
| `sanitizeSnapshot(raw)` | `persist-snapshot.ts` | The whole `WorkspaceSnapshotV1`: rejects non-`version: 1`, filters sessions through `isPersistedSession` + `dedupeById`, rejects unsafe record keys such as `__proto__` / `prototype` / `constructor`, validates/clamps `split` (mode + both panes must exist), sanitizes collapsed sidebar/diff records, validates and bounds terminal snapshots (finite numeric fields, latest 8 entries, 256 KiB serialized text per entry), prunes orphan `terminals`/`agentResume` whose session id is gone, repoints a dangling `activeSessionId` |
| `sanitizeCommandUsage(raw)` | `persist-snapshot.ts` | Drops non-finite values, keeps the 50 most-recent (mirrors the UI store's `recordCommandUse` cap) |
| `sanitizeRecentDirs(raw)` | `recent-dirs.ts` | Strings only, trimmed, de-duped, capped at `RECENT_DIR_LIMIT` (20) |
| `sanitizeRecentCommands(raw)` | `recent-commands.ts` | Strings only, trimmed, no newlines, de-duped, capped at `RECENT_COMMAND_LIMIT` (30) |
| Remote session sanitization | `persist-snapshot.ts` | White-lists host/port/user/identity path/shell-integration flag; drops any credential-like runtime fields before save or restore |
| Workflow sanitization | `persist-snapshot.ts` | Array of `Workflow`, each run through `sanitizeWorkflow` (from `src/modules/workflows/template.ts`); invalid entries dropped |

`sanitizeSnapshot` is the linchpin: `loadWorkspaceSnapshot`, `saveWorkspaceSnapshot`,
`saveSessions`, and `saveUILayout` all route the stored blob through it, so a
malformed file degrades gracefully (e.g. a split pointing at a deleted session
falls back to single-pane) instead of crashing restore, and any orphan runtime
state is pruned before it is written back. It lives in `persist-snapshot.ts` so
Node tests can exercise the restore boundary without loading the Tauri Store
plugin.

### Testability boundary

`sanitizeSnapshot`, `sanitizeRecentDirs`, and `sanitizeRecentCommands` live in
alias-free modules and are exercised directly by the Node test runner (for
example `tests/persist-snapshot.test.mjs` and `tests/lifecycle-replay.test.mjs`).
Keep durable restore decisions in those pure modules. `persist.ts` is allowed to
load `@tauri-apps/plugin-store`; the sanitizer layer should remain importable
with `node --experimental-strip-types --test`.

## 5. Gotchas for contributors

- **Touching the persisted shape risks breaking restore-on-restart.** The
  on-disk `WorkspaceSnapshotV1` outlives any single app version. A user
  upgrading reads JSON written by an older build, and a downgrade reads JSON
  from a newer build.
- **Keep `PersistedSession` and `isPersistedSession` in sync.** If you add a
  field to the persisted `Pick`, also widen `toPersistedSession`,
  `fromPersistedSession`, the restore mapping in `useInit.ts`'s `buildSnapshot`,
  and the `isPersistedSession` validator — otherwise the field is silently
  dropped or a restored session is rejected as invalid.
- **Prefer additive, optional fields.** New persisted data should be optional
  and tolerate absence, because old snapshots will not contain it.
- **A real schema change means bumping `version` and handling the migration.**
  `sanitizeSnapshot` hard-rejects anything that is not `version: 1`
  (returns `null`), so a bare version bump will silently discard every existing
  user's workspace. Add an upgrade step before changing the constant.
- **Don't persist live state.** Runtime fields (`runState`, `ptyId`, git
  `changes`, `terminalProgress`, …) are intentionally excluded; re-deriving them
  is cheaper and safer than persisting stale values.
- **Terminal snapshots must follow session lifetime.** Closing a session removes
  its in-memory terminal snapshot, and queued snapshot captures must skip writes
  once the session no longer exists. Otherwise a closed terminal can be written
  back as orphan scrollback before the next sanitizer pass.
- **The two save paths are separate.** Appearance/keybindings go to the config
  file on a 300 ms debounce; layout + sessions go to the snapshot. Adding a new
  layout pref means wiring both the UI-store subscriber selector in
  `useInit.ts` and the `sanitizeSnapshot` reader.
- **`sanitizeSnapshot` has direct unit coverage** (see
  `tests/persist-snapshot.test.mjs`) — when you change persisted shape, update
  that behavioral test plus the source-text assertions that prove `useInit.ts`
  wires the field into the stores.
