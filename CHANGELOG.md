# Changelog

All notable changes to Conduit. The project is still before a first tagged release, so this file tracks the current product boundary rather than inherited Terax release history.

## Unreleased

### Current Product Boundary

- Conduit is a Tauri + React + xterm.js desktop terminal with an intelligent sidebar.
- The main workflow is real PTY sessions, session state, Agent CLI recognition, and a right-side read-only review panel.
- The app is not an Agent management platform, chat product, MCP orchestrator, IDE, or Git GUI.

### Added

- Real PTY sessions through `portable-pty` and xterm.js.
- Multi-session sidebar grouped by working directory.
- Agent CLI detection for common terminal-launched tools.
- Read-only Git diff review panel with large/binary/metadata fallback states.
- Settings, command palette, split panes, window-state persistence, and macOS titlebar integration.

### Changed

- Removed the old standalone Agent platform direction from the main UI.
- Removed commit/push controls from the review panel. Users can run Git from the terminal instead.
- Reset public documentation away from inherited Terax product claims.
