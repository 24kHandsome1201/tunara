//! Coding-agent integration: lifecycle hooks, CLI preflight, per-session cleanup.
//!
//! Three submodules, no commands at this level:
//! - [`hooks`]: on Unix, a background listener thread binds a private
//!   `UnixListener` and forwards each agent start/exit JSON payload to the
//!   frontend as the `agent-hook` event. [`hooks::HookListenerState`] owns the
//!   socket path (injected into the shell as `TUNARA_HOOKS_SOCK`) and its
//!   shutdown flag; a no-op stub exists for non-Unix.
//! - [`preflight`]: detects whether an agent CLI is installed and logged in
//!   (resolving the bin via [`crate::modules::resolver`], probing e.g.
//!   `claude auth status`), memoized per-bin with a 30-minute TTL cache.
//!   Commands: `agent_preflight`, `agent_preflight_invalidate`.
//! - [`wrapper`]: [`wrapper::cleanup_hooks_settings`] deletes a session's
//!   leftover `tunara-agent-<id>.*.json` hook settings; called by `pty_close`.
//!
//! The agent registry (codes/commands/cli_bin) is the shared
//! `src/modules/agent/registry-data.json`, inlined here via `include_str!`.
pub mod hooks;
pub mod preflight;
pub mod wrapper;
