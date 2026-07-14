# M3 Agent Timeline core slice

## Scope

This slice adds a source-bound Agent Timeline to the existing Inspector. It reads only `AgentEventHeaderV1` pages from the existing Rust Event Store, never requests private payload, and never inserts text into a PTY. The active Tunara session is the task selector: `workspaceId` is a shared SHA-256 opaque key derived from the resolved repository identity and `taskId` is the session id. Events whose `sessionId` cannot be matched to a mounted Tunara session in that workspace remain visible as `unknown`, with terminal navigation disabled.

## Visual and interaction contract

- Visual: a card-light operational stream using the existing paper-terminal tokens, typography, radii and background steps. A stable source label plus one status accent is the signature.
- Content: orient by workspace, task and session first, then show high-signal transitions and bounded summaries with source, confidence, time and status.
- Interaction: load the newest page first; older pages prepend while preserving the visible event and pixel offset; follow only while the user is at the bottom; selection, paging and return-to-PTY are keyboard reachable and reduced-motion safe.

The bounded reference pass uses three mature developer-tool patterns without copying their visual brands: VS Code's dense Problems/Output rows for compact hierarchy and jump-to-source, JetBrains run tool windows for stable source context beside state, and GitHub Actions logs for explicit older/newer position and bottom-follow behavior. Tunara keeps only those interaction lessons. It uses the existing paper-terminal background layers rather than cards, glass, gradients, foreign icons, fonts or radii.

## Data and performance contract

- The capability/feature flag is checked before list reads. Disabled, unavailable, corrupt and migration-required states do not call `agent_event_list` and do not affect terminal mounting or input.
- Pages contain at most 100 headers. The UI retains at most 600 headers for one active task and renders only the viewport plus bounded pixel overscan. Loading farther back drops the newest retained page and offers an explicit return to latest, so 10,000 headers never become one frontend array or DOM tree.
- Dynamic row heights are measured with `ResizeObserver`; the virtual window uses measured heights plus a conservative estimate. Prepend and measurement corrections restore an event id plus pixel offset.
- Live append notifications are coalesced to one animation frame. Existing header objects remain referentially stable; only the newest streaming row receives transient state and then becomes immutable.
- Per-task scroll position, bottom-follow state and unread count are ephemeral and keyed by workspace/task. Switching sessions restores that task's position. Restart reloads the newest page from the durable Rust store without persisting private content in the UI snapshot.

## Verification fixtures

Deterministic tests cover a 10,000-header sequence, bounded retention and DOM window size, one high-rate streaming row, multiple task switches, prepend during append and Event Store reopen. Large fixtures, raw logs, screenshots and full command output stay in ignored cache or temporary directories.
