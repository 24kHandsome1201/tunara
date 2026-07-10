<p align="center">
  <img src="assets/brand/tunara-app-icon-preview-128.png" width="120" alt="Tunara">
</p>

<h1 align="center">Tunara</h1>

<p align="center">
  A lightweight, good-looking, AI-native sidebar terminal.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/24kHandsome1201/tunara/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/24kHandsome1201/tunara?label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS-Apple%20Silicon-black">
  <img alt="Built with" src="https://img.shields.io/badge/Tauri-2.x-24C8DB">
</p>

---

## Why this exists

Warp keeps adding features it doesn't need. It boots slowly, eats memory, and drifts further from being a terminal you reach for every day. cmux and Wave have the right instincts, but their styling is the kind you don't want sitting in your Dock. macOS Terminal and iTerm2 never grew a sidebar, so juggling several projects means a forest of tabs you switch through by muscle memory.

Tunara is built for that gap. A local terminal — **real PTY, xterm.js, WebGL** — no cloud, no account, no telemetry. A sidebar on the left groups sessions by working directory so a glance tells you which project is running and which AI agent is in it. A read-only review rail on the right lets you eyeball your diff before you commit. The installer is about 30 MB and the app opens nearly instantly.

It is not a Warp replacement. It is for people who **switched back to iTerm and still feel something is missing**.

## Screenshots

<p align="center">
  <img src="assets/screenshots/tunara-split-agents.jpg" width="960" alt="Tunara running Claude Code and Codex in a split terminal workspace">
</p>

<p align="center">
  <em>A real terminal workspace with a smart session sidebar, agent detection, split panes, and a read-only review rail.</em>
</p>

| Focused terminal | Session sidebar | Review rail |
|------------------|-----------------|-------------|
| <img src="assets/screenshots/tunara-codex-terminal.jpg" width="300" alt="Tunara focused Codex terminal session"> | <img src="assets/screenshots/tunara-sidebar-sessions.jpg" width="300" alt="Tunara sidebar grouping Claude Code and Codex sessions by directory"> | <img src="assets/screenshots/tunara-claude-review-rail.jpg" width="300" alt="Tunara Claude Code session with the right review rail open"> |

## Core capabilities

### Terminal

The terminal is the product, not an accessory. Sessions run real `portable-pty`; the frontend uses xterm.js 6 with the WebGL renderer, so scrolling and bursty output stay smooth. Output is batched with `requestAnimationFrame` and protected by a two-layer backpressure budget (1 MiB PTY / 2 MiB frontend), so `cat`-ing a large log will not lock the UI.

- Multi-session PTYs, horizontal/vertical split, max two panes (no recursive tiling — predictability wins)
- ⌘F in-terminal search with match counts
- Command-block history follows live scrollback, with navigation and output filters for text / regex / case / invert / context lines
- Clickable URLs, configurable scrollback (1k–20k lines)
- OSC 7 cwd tracking, OSC 133 shell integration
- 7 terminal themes: default, catppuccin, tokyo-night, one-dark, solarized, github-light, rose-pine-dawn

### Smart sidebar

The sidebar is what visually separates Tunara from every other terminal. Sessions group by working directory; multiple sessions in the same project fold together; directory groups collapse, batch-close, and drag as a unit; sessions themselves rename, search, and fuzzy-match in place.

- Directory groups: collapse / expand / batch close
- Drag to reorder, fuzzy search filter, inline rename
- Unread indicator + explicit running-state marker
- Close-confirm guard: a running session needs a double click — no accidental kills mid-task
- Restores session list and UI layout across restarts

### Workspace cockpit

Tunara now has a small cockpit layer for people who keep several sessions open all day. It helps you see the state of the workspace, keep important sessions visible, and leave lightweight notes without leaving the terminal.

- Session overview cards expose cwd, agent, Git, notes, and quick actions in one place
- Session Notes add autosaved per-session scratchpads with task counts
- Pinned sessions get a star marker and float higher in command-palette session results
- Starter workflows can add common review and cleanup commands in one click

Future direction and feature notes live in [docs/ROADMAP.md](docs/ROADMAP.md).

### AI agent detection

If you use CLI agents like Claude Code, Codex, or Aider day to day, Tunara recognizes them and pins a brand badge on the session. No setup — it kicks in the moment the PTY matches a known agent command.

- Auto-detects 12 agent CLIs: Claude Code, Codex, Amp, Gemini, Copilot, Cursor, Droid, OpenCode, Pi, Auggie, Devin, Aider
- Compact contextual strip shows agent state: starting / idle / running
- Agent hooks listen for structured lifecycle events (start, thinking, tool call, done)
- File-change counts per agent, plus an entry point to preview those changes

What it explicitly does **not** do: bundled AI chat, model integration, MCP orchestration, agent launcher, or structured parsing of agent stdout. Tunara recognizes who is running. It does not run the agent for you.

### Review rail

The right pane is a read-only git diff for "one more look before commit." Reads go through git2 (zero-process overhead); writes always go through the system `git` CLI — meaning, **Tunara will never commit or push on your behalf**.

- Staged / Unstaged / Untracked, three-section layout
- File browser + code preview, syntax highlighting + Markdown rendering
- One-click jump to an external editor: VS Code / Cursor / Zed / Sublime
- Graceful fallback for binary / oversized files
- Ahead / behind remote indicator

### Desktop experience

- ⌘K Command Palette with weighted ranking, covers every action and session switch
- Light/dark mode + system follow, 5 accent colors
- Solid paper surfaces + native macOS overlay titlebar
- Toast notifications: exit animation, hover pause, progress bar
- Delayed signed-update reminders that stay silent until a release is actually available
- Right-click menus on sessions, directory groups, and files
- Responsive layout: narrow windows auto-collapse sidebar / right rail
- Window-state persistence (position, size)

## Install

### From a Release (recommended)

Grab the latest `.dmg` from [Releases](https://github.com/24kHandsome1201/tunara/releases/latest). Use the normal `Tunara_<version>_aarch64.dmg` for direct install. Only signed macOS Apple Silicon builds are supported for the direct installer.

Release pages may also include `Tunara_<version>_aarch64-legacy.dmg`. That is the previous manual install path for cases where Apple notarization is delayed; it is not used by Homebrew or the in-app updater and may require right-click Open in Finder.

### Homebrew

```bash
brew tap 24kHandsome1201/tunara https://github.com/24kHandsome1201/tunara
brew install --cask tunara
```

Use Settings > App to check, install, and restart into a new release. Homebrew users can also update with `brew upgrade --cask tunara`.

### From source

```bash
pnpm install
pnpm tauri build
```

Prerequisites: Rust stable, Node 20+, pnpm 9+, plus the platform-specific [Tauri dependencies](https://tauri.app/start/prerequisites/).

## Development

```bash
pnpm install          # install dependencies
pnpm tauri dev        # dev mode
pnpm build            # frontend build
pnpm typecheck        # type-check
pnpm test             # all tests (Node + Rust)
```

Deeper developer docs live under [`docs/`](docs/):

- [Architecture](docs/ARCHITECTURE.md) — the frontend↔backend IPC surface: every Tauri command, the three transports (`invoke` / `Channel<PtyEvent>` / `git-changed` & `agent-hook` events), and the managed state objects.
- [Testing](docs/TESTING.md) — the `.mjs`-imports-`.ts` pure-logic convention, the source-assertion style, the Node + Cargo split, and how to add a test.
- [Agent detection](docs/AGENT_DETECTION.md) — how agent detection & lifecycle work, plus a step-by-step checklist for adding a new agent.
- [State & persistence](docs/STATE_AND_PERSISTENCE.md) — the Zustand dual store, the persisted workspace snapshot, and the contributor gotchas around restore-on-restart.

## Keybindings

| Action | macOS | Windows / Linux |
|--------|-------|-----------------|
| New terminal | ⌘T | Ctrl+T |
| Close session | ⌘W | Ctrl+W |
| Split horizontal | ⌘D | Ctrl+D |
| Split vertical | ⌘⇧D | Ctrl+Shift+D |
| Switch pane focus | ⌘] / ⌘[ | Ctrl+] / Ctrl+[ |
| Command Palette | ⌘K | Ctrl+K |
| Find in terminal | ⌘F | Ctrl+F |
| Switch to session N | ⌘1 – ⌘9 | Ctrl+1 – Ctrl+9 |
| Font size +/- | ⌘+ / ⌘- | Ctrl++ / Ctrl+- |
| Toggle sidebar | ⌘\ | Ctrl+\ |
| Settings | ⌘, | Ctrl+, |

## Stack

| Layer | Choice |
|-------|--------|
| Frontend | React 19, Zustand 5, xterm.js 6 + WebGL, Vite 7, TypeScript 5.8 |
| Backend | Tauri 2, Rust, portable-pty, git2, tokio, which |
| Fonts | JetBrains Mono (UI / terminal / code), PingFang SC fallback |
| Build | pnpm 9 |

Final installer is around 30 MB, against Warp's ~150 MB.

## Layout

```
src/                    # React frontend
├── app/                # entry, init, keybindings, theme
├── modules/            # terminal / git / fs / agent / editor
├── state/              # Zustand (sessions + ui + persist)
├── styles/             # CSS tokens + terminal themes
└── ui/                 # Sidebar, MainArea, DiffPanel, etc.

src-tauri/src/          # Rust backend
├── modules/
│   ├── pty/            # portable-pty session management
│   ├── git/            # git2 read-only operations
│   ├── fs/             # directory tree, search, grep
│   ├── agent/          # CLI pre-check + hooks listener
│   ├── editor/         # external editor jump
│   ├── resolver/       # binary path resolution
│   └── process/        # subprocess management
└── lib.rs              # Tauri command registration
```

## Roadmap

1.0 shipped; mainline features were fully wrapped in 1.5.0 (terminal-block navigation / quick select / OSC 8 / Aider agent and more):

| Milestone | Status | Contents |
|-----------|--------|----------|
| M0 Store | done | Zustand dual-store + Tauri Store persistence |
| M1 Multi-session | done | Multi-PTY, sidebar grouping, tab navigation |
| M2 Agent | done | 12 agent CLIs auto-detected |
| M3 Git Diff | done | git2 + read-only review rail |
| P0 Split Pane | done | Horizontal / vertical split + draggable divider |
| P0 Session lifecycle | done | runState state machine + semantic state markers |
| P1 Persistence | done | Sessions + UI layout across restarts |
| P1 Sidebar titles | done | OSC 133 command / agent inference |
| P2 Command Palette | done | ⌘K, fuzzy match, weighted ranking |
| P3 Agent status bar | done | Contextual strip + change counts |
| Session Recovery | done (1.2) | xterm buffer snapshot + scrollback restore |
| SSH Client | done (1.7) | russh long-lived conn, SFTP browse + download, host profiles, opt-in remote shell integration |

See [CHANGELOG](CHANGELOG.md).

## Explicit non-goals

What we will not build matters as much as what we will. These are off the roadmap, and PRs adding them will not be merged:

- Bundled AI chat / model integration / MCP orchestration
- Agent catalog, agent launcher, batch-launch entry points
- Structured parsing of agent stdout, agent change timeline
- Stage / commit / push or any write operations in the DiffPanel
- Plugin system, custom renderer, recursive tile splits
- Telemetry, analytics, any kind of phone-home

The test is simple: keep the terminal a terminal, not the next IDE or the next agent console.

## Contributing

Bug fixes, new agent detection, and new terminal themes are welcome. For anything larger, please open an Issue first. See [CONTRIBUTING](CONTRIBUTING.md) and [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md).

Security issues go through the private channel described in [SECURITY](SECURITY.md) — please do not open a public Issue.

## Credits

- The project began from the [terax-ai-tauri-terminal](https://github.com/emee-dev/terax-ai-tauri-terminal) Tauri + xterm scaffold, and has been fully rewritten since. Original copyright and license: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
- Terminal core thanks to [xterm.js](https://xtermjs.org/), [portable-pty](https://github.com/wez/wezterm/tree/main/pty), and [git2-rs](https://github.com/rust-lang/git2-rs).
- Desktop shell thanks to [Tauri](https://tauri.app/).

## License

[Apache-2.0](LICENSE)
