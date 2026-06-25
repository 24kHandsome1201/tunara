# Security

Tunara runs local shells, reads files for review surfaces, and exposes a Tauri IPC boundary to the renderer. Security bugs matter. If you find one, report it privately before posting details publicly.

## Reporting

Open a private security advisory on GitHub, or contact the maintainer listed on the repository. Include:

- What the issue is and what it lets an attacker do
- Steps to reproduce (a small PoC is great)
- Version, OS, arch

We'll get back to you within a few days. Once it's fixed, we'll credit you in the release notes — unless you'd rather stay anonymous.

Please **don't** open a public GitHub issue for security reports.

## Supported versions

Until `1.0.0`, only the current development line is expected to receive security fixes.

## What's in scope

- The Rust backend in `src-tauri/` (PTY, FS, IPC, plugins)
- The frontend in `src/` — anywhere untrusted input lands (terminal output, file content, AI tool results, credentials)
- Release artifacts on GitHub and the auto-updater

## What's not

- Bugs in upstream deps such as Tauri, xterm.js, `portable-pty`, or git2. Report those upstream first; Tunara can pick up fixed releases.
- Anything that needs an already-compromised machine or a local attacker with shell access
- Old local prototypes or unreleased design artifacts

## What we do to keep things safe

- **Host access is behind Tauri commands.** The frontend reaches PTY, file, Git, resolver, editor, config, and agent-hook functionality through the allow-listed IPC surface in `src-tauri/src/lib.rs` and `src-tauri/capabilities/`.
- **No Node in the renderer.** The webview does not receive direct Node-style filesystem or process access.
- **Git write operations are not part of the main UI.** The current review panel is read-only; users run mutating Git commands from the terminal when they choose to.
- **Terminal clipboard writes are opt-in.** OSC 52 clipboard writes are disabled by default and only enabled by `terminal_clipboard_write = true`; Tunara does not implement clipboard read responses.
- **Signed updates.** Tauri updater configuration verifies update signatures before applying releases.
- **No product telemetry is expected in the current app shell.** Network access is limited to explicit user workflows, external CLIs launched by the user, and update checks.

## What we can't promise

- Tunara runs whatever you type into the terminal, with your user permissions. That is the point of a terminal.
- Agent CLIs such as Claude Code, Codex, or Amp are external tools. Their authentication, data retention, and network behavior are controlled by those tools, not by Tunara.
- Any local command, shell startup file, Git hook, or CLI plugin can affect the workspace. Review the tools you run.
