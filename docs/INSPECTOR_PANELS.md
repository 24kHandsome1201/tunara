# Inspector

The Inspector is Tunara's contextual right rail. It keeps review, files, Preview, transfers, and forwarding close to the terminal without becoming a second dashboard or an IDE. Chinese UI copy uses **检查器**.

The container is [`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx). Available views are defined by [`inspector-navigation.ts`](../src/ui/inspector-navigation.ts). Scope contracts come from [`inspector-scope.ts`](../src/ui/inspector-scope.ts); technical descriptions stay in tooltips while project/branch or remote host identity is visible. Only the active view is mounted. On narrow windows the rail becomes an overlay. Contrast stays stable when the terminal is focused; ⌘⇧\\ still hides it.

## Interaction model

The Inspector defaults to Files and remembers the user's selection. Background changes, Preview discovery, and transfer activity never switch the current view. There is no automatic-follow or hidden-lock state.

### Progressive navigation

| View | Header visibility |
|---|---|
| Files / Changes | Always visible as text tabs |
| Preview | A source is available, previously opened in this session, or currently selected |
| Transfers | SSH transfer queued/running, or currently selected |
| Other available tools | More menu and ⌘K; selected tools remain visible |

Tabs may become available without being selected. Jupyter notebook preview and Excel/table preview remain Files capabilities; they are not separate Inspector views.

## Reader pane

Opening a file from Files, Changes, a terminal path, or a completed transfer inserts a `reader` leaf to the right of that session’s terminal (40% terminal / 60% reader). One reader per session; history lives on `‹ ›` and the filename menu. The terminal stays visible. Closing the reader (✕ or ⌘W while focused) restores the terminal to full width. The pane counts toward the four-split cap; a full layout toasts “Split is full” instead of opening.

The reader receives keyboard focus when activated. Return to terminal keeps the reader open; closing returns to its owning terminal. Escape on the reader background returns focus, while search inputs keep their own Escape behavior. Focus transitions invalidate stale asynchronous focus-return tokens.

When the extra column would make the terminal unusable, the Inspector docks as an overlay (`⌘⇧\\` still recalls it). Session switch keeps each reader’s layout and drafts mounted. SSH reconnect re-fetches the same path on the new binding.

Changes opens read-only diffs in this same reader, not inside the narrow Inspector. File, staged diff, and unstaged diff have distinct history entries. Unsaved file drafts still require confirmation before navigating to a diff. Remote reads are canceled on disconnect and reload on the new binding after reconnect.

Switching sessions retains the selected view if available; a local session cannot show SSH-only tools and falls back to Files. The saved selection is global, not a separate per-session preference.

## Views

| View | Availability | Scope | Purpose |
|---|---|---|---|
| Changes | Local and SSH sessions | Repository profile | Read-only staged, unstaged, and untracked review |
| Files | Local and SSH sessions | Session or active SSH binding | Browse, search, safely preview/edit, and start SSH transfers |
| Preview | Local and SSH sessions | Session/source | Isolated workspace-bound loopback WebView |
| Transfers | SSH sessions | Logical session | Upload/download progress, cancellation, and recovery |
| Forwarding | SSH sessions | Active SSH binding | Local, dynamic, and reverse port forwarding |

⌘K reaches every view (`Open changes` / `Open files` / `Open Preview`, plus SSH `Open Transfers` / `Open Forwarding`). When no longer valid, stored legacy tab values fall back to Changes.

Remote file properties remain a Files context action. Connection diagnostics remain available through the SSH diagnostic flow, and known hosts remain under Settings → Connections & transfers; neither is a separate Inspector view.

## Product boundary

- Changes remains read-only: no stage, commit, push, or destructive Git actions.
- Files preserves local workspace containment, SSH binding checks, conflict-checked writes, and transfer recovery.
- Preview preserves source binding, navigation restrictions, WebView isolation, and explicit SSH tunnel boundaries.
- Transfers and Forwarding are hidden without an SSH context and reject stale transport generations.
- The Inspector does not keep per-session notes, activity timelines, or a fixed overview/dashboard.

Legacy snapshots may still contain retired Inspector tab names or a session `note` field. Snapshot sanitization ignores unknown session fields and maps invalid tabs to Changes; there is no user-visible migration or cleanup action. “Preview opened” is runtime UI and is not persisted; the selected Inspector tab is persisted.
