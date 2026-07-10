# Agents

How Tunara detects an AI coding agent inside a terminal session, tracks its
lifecycle, and renders it in the sidebar — plus a checklist for adding a new one.

New-agent PRs are welcome (see `CONTRIBUTING.md`). In the common case you only
edit one JSON file and add an icon; the data model is built so that a single
entry propagates to both the Rust backend and the React frontend.

## The data model: one JSON file, two consumers

The single source of truth is [`src/modules/agent/registry-data.json`](../src/modules/agent/registry-data.json).
It is a flat array of entries; each entry has exactly these fields:

```jsonc
{
  "code": "CC",                                   // 2-letter AgentCode
  "name": "Claude Code",                          // display name in the sidebar
  "commands": ["claude"],                         // command tokens that launch it
  "shellTitleFragments": ["claude code", "claude"], // OSC-title substrings to match
  "cliBin": "claude"                              // binary name the resolver/preflight look up
}
```

| Field                 | Type       | Used for |
| --------------------- | ---------- | -------- |
| `code`                | `string`   | The `AgentCode` key. Drives badge/icon lookup, lifecycle sets, state. |
| `name`                | `string`   | Sidebar display name (`AGENT_NAMES[code]`). |
| `commands`            | `string[]` | First-token command match in the typed/submitted command line. |
| `shellTitleFragments` | `string[]` | Substring match against the terminal's OSC title (lowercased). |
| `cliBin`              | `string`   | The binary the backend resolves (`gh` for Copilot, etc.) — not always equal to `commands[0]`. |

That same JSON file is consumed two ways:

- **Frontend** — [`src/modules/agent/registry.ts`](../src/modules/agent/registry.ts)
  imports it with `import ... with { type: "json" }` and derives the lookup
  tables the UI uses: `AGENT_REGISTRY`, `AGENT_NAMES`, `AGENT_COMMANDS`
  (flat-mapped command → code), `AGENT_CODES` (a `Set`), and
  `AGENT_SHELL_TITLE_FRAGMENTS` (trimmed + lowercased).
- **Backend (Rust)** — both
  [`src-tauri/src/modules/resolver/mod.rs`](../src-tauri/src/modules/resolver/mod.rs)
  and [`src-tauri/src/modules/agent/preflight.rs`](../src-tauri/src/modules/agent/preflight.rs)
  embed the exact same file at compile time:

  ```rust
  const AGENT_REGISTRY_JSON: &str =
      include_str!("../../../../src/modules/agent/registry-data.json");
  ```

  Rust deserializes it with `serde(rename_all = "camelCase")`, so `cliBin` maps
  to the Rust field `cli_bin`. The resolver only reads `code` + `cliBin`;
  preflight reads `code` + `commands` + `cliBin`.

So adding an agent to the JSON file makes it resolvable, preflightable, and
detectable on both sides at once — no parallel list to keep in sync.

## Two detection paths

A session can pick up an agent two ways. Both end at the same session-store
transitions in [`src/state/sessions.ts`](../src/state/sessions.ts)
(`handleAgentDetected` / `handleAgentReady` / `handleAgentExited` /
`handleAgentBusy`).

### Path A — command / shell-title heuristic

This is the always-available fallback, driven entirely by the registry tables in
[`agent-lifecycle.ts`](../src/modules/terminal/lib/agent-lifecycle.ts):

- `detectAgentCommand(commandLine)` cleans the line, takes the first
  whitespace-delimited token, lowercases it, and looks it up in `AGENT_COMMANDS`.
  This fires when the user submits a command in the PTY
  (`TerminalView.tsx` → `submitAgentInput` / OSC 133 `C` command extraction).
- `isAgentShellTitle(title)` matches an OSC window title against the agent's
  `name`, its `commands`, or any `shellTitleFragments` substring. Used by
  `shellTitleUpdate` in
  [`session-lifecycle.ts`](../src/modules/terminal/lib/session-lifecycle.ts) so
  an agent that retitles the terminal (e.g. "Claude Code") is still recognized,
  and so an agent-style title does not pollute the session's derived title.

When a match is found, `TerminalView.tsx` calls
`useSessionsStore.getState().handleAgentDetected(sessionId, agent, command)`.

### Path B — runtime hook lifecycle

For agents that emit real lifecycle signals, Tunara injects shell wrappers and a
hook config so the agent reports `start` / `busy` / `idle` / `stop` / `exit` directly.
Two transports carry the same event shape, for redundancy:

1. **OSC 777** — every wrapper prints process `start`/`exit`; hook-capable
   agents also write per-turn `busy`/`idle`/`stop` events to `/dev/tty` from
   their native hook helper. Events use
   `OSC 777 ; tunara-agent ; <event> ; <session> ; <agent> ; <code>` via
   `_tunara_agent_osc`. `TerminalView.tsx` registers
   `term.parser.registerOscHandler(777, applyAgentLifecycleEvent)`, which calls
   `parseAgentLifecycleOsc(data)` (accepts the `tunara-agent` and legacy
   `conduit-agent` prefixes) and routes by event. This path needs nothing
   external — it travels in the PTY byte stream.
2. **Unix-socket hook** — on local sessions, the same helper also pipes a JSON
   payload (`{"event","session","agent","code","agent_session_id"}`) to the
   socket via `nc -U "$TUNARA_HOOKS_SOCK"` when available. The backend
   [`hooks.rs`](../src-tauri/src/modules/agent/hooks.rs) `start_listener` binds a
   private `UnixListener` (under `$XDG_RUNTIME_DIR/tunara` or
   `~/.cache/tunara/runtime`, chmod `0700`), reads each connection, and re-emits
   it to the webview as the Tauri event **`agent-hook`**. The frontend
   [`hooks-listener.ts`](../src/modules/terminal/lib/hooks-listener.ts)
   (`startHooksListener`, started in `useInit.ts`) listens for `agent-hook` and
   maps it onto the same store transitions.

The socket path + its parent config dir are passed into the PTY as env vars by
[`shell_init.rs`](../src-tauri/src/modules/pty/shell_init.rs):
`TUNARA_SESSION_ID`, `TUNARA_HOOKS_SOCK`, and `TUNARA_AGENT_CONFIG_DIR` (the
socket's parent directory). The shell scripts only install the agent wrappers
when `TUNARA_SESSION_ID` is set.

#### What the wrappers do

The injected scripts —
[`zshrc.zsh`](../src-tauri/src/modules/pty/scripts/zshrc.zsh),
[`bashrc.bash`](../src-tauri/src/modules/pty/scripts/bashrc.bash),
[`config.fish`](../src-tauri/src/modules/pty/scripts/config.fish) — define shell
functions that shadow the agent binaries. There are two wrapper flavors:

- `_tunara_agent_run <bin> <code>` — full hook integration. Emits `start`, then
  creates a private runtime directory in `$TUNARA_AGENT_CONFIG_DIR`
  (`tunara-agent-<sid>.XXXXXX`, chmod `700`) containing the agent's own
  `SessionStart` / `UserPromptSubmit` / `Stop` / `StopFailure` /
  `Notification(idle_prompt)` hooks. They map to `idle` / `busy` / `stop`
  semantic events, capture the agent's real session id, and emit over OSC 777
  plus the optional local socket. Claude loads the runtime as a transient plugin
  with `--plugin-dir`, so a user-supplied `--settings` remains independent.
  Droid has only one effective settings input: the wrapper removes duplicate
  `--settings` flags, preserves the last user value, appends Tunara's hooks to
  the user's hook arrays, and passes one merged `--settings` file. It always
  emits `exit` with the process exit code. Native hooks only require the private
  config directory and helper; the socket is a redundant transport, not a
  prerequisite. Remote SSH creates the same plugin/settings runtime on the
  remote host and uses OSC 777 because the local Unix socket is unreachable.
- `_tunara_agent_plain_run <bin> <code>` — emits `start` + `exit` only, no
  `--settings` injection. Used for agents whose `--settings`/hook contract Tunara
  does not drive.

Currently wired (identical across all three shells):

```sh
function claude { _tunara_agent_run claude CC "$@"; }   # full hooks
function droid  { _tunara_agent_run droid DR "$@"; }     # full hooks
function codex  { _tunara_agent_plain_run codex CX "$@"; } # start/exit only
```

Before installing these functions, the wrapper captures ordinary aliases whose
expansion starts with the same agent binary. For example,
`alias claude='claude --model opus'` is rebuilt through `_tunara_agent_run`, so
the default flags and lifecycle events both survive. Arbitrary user-defined
functions are not introspected or evaluated.

The temp runtime directory is cleaned up by the wrapper on exit, and orphans are
swept by `cleanup_hooks_settings` in
[`wrapper.rs`](../src-tauri/src/modules/agent/wrapper.rs) when the PTY closes.
The Droid merge helper prefers `python3`, then `node`, then `jq`. If none exists
or the user settings cannot be parsed, the wrapper deliberately passes the
original user settings unchanged; only exact per-turn state degrades to the
wrapper's `start`/`exit` signals instead of silently discarding user policy.

### The state machine

Session agent state lives in `Session.agentActivity`
([`src/ui/types.ts`](../src/ui/types.ts)), distinct from the plain-command
`runState`:

```
type AgentActivity = "starting" | "idle" | "running";
```

Two `Set`s in [`agent-lifecycle.ts`](../src/modules/terminal/lib/agent-lifecycle.ts)
classify how confidently an agent reports readiness:

```ts
export const HOOK_READY_AGENTS  = new Set<AgentCode>(["CC", "DR"]);
export const PROMPT_READY_AGENTS = new Set<AgentCode>(["CX"]);
```

`initialAgentActivity(agent)` picks the starting state on detection:

| Membership                       | Initial `agentActivity` | Why |
| -------------------------------- | ----------------------- | --- |
| `HOOK_READY_AGENTS` (CC, DR)     | `"starting"`            | Hooks will report `idle` once the agent is ready; show a startup state until then. |
| `PROMPT_READY_AGENTS` (CX)       | `"idle"`                | Readiness is inferred from the on-screen prompt, so assume idle and let the screen-state tracker flip it busy. |
| anything else                    | `"running"`             | No reliable readiness signal — treat the session as busy while the agent is up. |

Transitions (via the store handlers and the
`*Update` helpers in `session-lifecycle.ts`):

- **Detected** (`handleAgentDetected`) → `agent` set, `agentActivity =
  initialAgentActivity(agent)`, `runState = "idle"`, title becomes the agent name.
  Also builds an `AgentResumeIntent` (see below).
- **Busy** (`handleAgentBusy`) → `agentActivity = "running"`. Fired by the
  native `UserPromptSubmit` hook, by typed-input fallback, or when the Codex
  screen-state tracker sees busy indicators.
- **Ready** (`handleAgentReady`) → `agentActivity = "idle"`; if the previous
  state was `"running"` it counts as a completed turn (`completedAt`, `unread`
  when inactive, toast). Fired by hook `idle`/`stop`, by the OSC `idle`/`stop`
  events, and by `shouldUseStartupQuietReadyFallback` (a `HOOK_READY_AGENTS`
  agent that goes quiet during startup while still `"starting"`).
- **Exited** (`handleAgentExited`) → clears `agent`/`agentActivity`, resets the
  title, suppresses the stale shell title, refreshes git. Fired by hook `exit`,
  OSC `exit`, or PTY close.

`isAgentActivityBusy` (`"starting"` or `"running"`) and `isSessionBusy` gate the
sidebar busy indicator and close-confirmation.

`PROMPT_READY_AGENTS` is paired with the Codex screen-state heuristic in the same
file (`detectCodexScreenState`, `CODEX_BUSY_INDICATORS`,
`CODEX_PROMPT_PATTERN`), driven by
[`terminal-codex-state.ts`](../src/modules/terminal/lib/terminal-codex-state.ts):
because Codex doesn't emit hook events, Tunara scrapes the last few rendered
lines to decide `ready` vs `busy`.

### Resume

[`agent-resume.ts`](../src/modules/terminal/lib/agent-resume.ts) builds a resume
command from an `AgentResumeIntent`. Only `CC` and `CX` have resume mappings:
`claude --resume <id>` / `claude --continue`, and
`codex resume <id>` / `codex resume --last`. When no exact id or explicit
continue intent is known, both agents open their interactive resume picker;
Tunara never guesses the globally most recent conversation for that case. Other agents return
`null` (no resume).

Non-interactive utility invocations (`claude --version`, `claude auth`,
`codex exec`, `codex mcp`, and similar commands) are deliberately excluded
from `AgentResumeIntent`; starting the binary is not itself evidence of an
interactive session that can be resumed.

## Preflight & resolution

When the UI is about to start an agent it calls the `agent_preflight` Tauri
command ([`preflight.rs`](../src-tauri/src/modules/agent/preflight.rs)):

1. `agent_bin(agent)` maps the input (a `code`, a `cliBin`, or a `command`) to
   the entry's `cliBin`.
2. `ResolverState::resolve(bin)`
   ([`resolver/mod.rs`](../src-tauri/src/modules/resolver/mod.rs)) finds the
   binary: user override → login-shell `PATH` → `which` / common bin dirs.
   This exists because a Finder-launched `.app` does not inherit your shell
   `PATH`.
3. Login status is only checked for known bins — `claude` (`auth status`),
   `codex` (`login status`), `gh` (`auth status`). Every other bin is reported
   `installed: true, logged_in: true` once found. Results are cached for 30 min.

`resolve_all_bins` returns one `ResolvedCommand` per registry entry (keyed by
`code`) for the settings page.

## Adding an agent — checklist

1. **Add the entry to the registry.** Edit
   [`src/modules/agent/registry-data.json`](../src/modules/agent/registry-data.json):
   pick a unique 2-letter `code`, set `name`, `commands` (no command may be
   claimed by two agents), `shellTitleFragments`, and `cliBin` (the binary the
   resolver should look up — e.g. Copilot uses `gh`). This one edit flows to the
   Rust resolver/preflight and the frontend registry automatically.

2. **Extend the `AgentCode` union.** Add the new `code` to the union in
   [`src/ui/types.ts`](../src/ui/types.ts) (around line 7). The frontend lookup
   tables and badge/icon maps are typed against this union.

3. **Add a badge + icon.** In [`src/ui/agents/`](../src/ui/agents):
   - add an SVG icon component and register it under the new `code` in the
     `AGENT_ICONS` map in [`icons.tsx`](../src/ui/agents/icons.tsx);
   - add a circle-style entry under the new `code` in `AGENT_CIRCLE_STYLES` in
     [`badge.tsx`](../src/ui/agents/badge.tsx) (it references
     `--c-agent-<code-lowercased>-*` CSS custom properties — add those to your
     token CSS, or the badge falls back to the `CC` palette).
   No change to [`index.ts`](../src/ui/agents/index.ts) is needed; it re-exports
   the maps.

4. **Confirm `cliBin` resolves & preflights.** Make sure the `cliBin` you chose
   is the actual binary name. If the agent has a checkable login state, add its
   `login_args` arm in `preflight.rs`; otherwise it will preflight as
   `installed && logged_in` once the binary is found.

5. **If the agent supports hooks, wire the wrappers.** Add the shell function in
   all three PTY scripts —
   [`zshrc.zsh`](../src-tauri/src/modules/pty/scripts/zshrc.zsh),
   [`bashrc.bash`](../src-tauri/src/modules/pty/scripts/bashrc.bash),
   [`config.fish`](../src-tauri/src/modules/pty/scripts/config.fish) — using
   `_tunara_agent_run <bin> <CODE>` (after defining how its native hooks compose
   with user configuration) or `_tunara_agent_plain_run <bin> <CODE>` (for
   `start`/`exit` only, like Codex). Then decide the readiness class: add the
   `code` to `HOOK_READY_AGENTS` or `PROMPT_READY_AGENTS` in
   [`agent-lifecycle.ts`](../src/modules/terminal/lib/agent-lifecycle.ts), or
   leave it out to default to `"running"`. If the agent has a resume CLI, add a
   branch to `buildAgentResumeCommand` in
   [`agent-resume.ts`](../src/modules/terminal/lib/agent-resume.ts).

6. **Run the tests and update the asserted counts.** `pnpm test` runs both
   `pnpm test:node` and `cargo test`. Several tests hard-code the registry
   length (currently **12**) — changing the count means updating all of them:
   - [`tests/agent-registry.test.mjs`](../tests/agent-registry.test.mjs) —
     `assert.equal(AGENT_REGISTRY.length, 12)`.
   - [`src-tauri/src/modules/resolver/mod.rs`](../src-tauri/src/modules/resolver/mod.rs)
     — `assert_eq!(entries.len(), 12)` in `resolver_uses_shared_agent_registry_data`.
   - [`src-tauri/src/modules/agent/preflight.rs`](../src-tauri/src/modules/agent/preflight.rs)
     — `assert_eq!(entries.len(), 12)` in `preflight_uses_shared_agent_registry_data`.

   If you touched the wrappers or readiness sets, also check
   [`tests/agent-lifecycle-source.test.mjs`](../tests/agent-lifecycle-source.test.mjs)
   and the `hookable_agent_wrappers_match_cli_settings_support` test in
   `hooks.rs`, which assert the exact wrapper lines and the `HOOK_READY_AGENTS` /
   `PROMPT_READY_AGENTS` contents.
