# Inspector

The Inspector is Tunara's contextual right rail. It keeps review, files, Preview, transfers, and forwarding close to the terminal without becoming a second dashboard or an IDE. Chinese UI copy uses **检查器**.

The container is [`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx). Available views are defined by [`inspector-navigation.ts`](../src/ui/inspector-navigation.ts). Auto-follow and lock live in [`inspector-context.ts`](../src/ui/inspector-context.ts). Scope labels come from [`inspector-scope.ts`](../src/ui/inspector-scope.ts). Only the active view is mounted. On narrow windows the rail becomes an overlay; Pure Mode can project Files alone without changing the stored Inspector selection.

## Interaction model

The Inspector follows the active session by default. Manual switching remains available, but chrome is secondary: a compact icon switcher in the header, plus ⌘K.

### Automatic selection

| Session state | Default Inspector view |
|---|---|
| Unreviewed Git changes (`reviewChangesHint` and a non-empty `changes.files`) | **Changes** |
| Loopback/localhost URL detected **and** the user has opened Preview for this session | **Preview** |
| SSH file transfer queued or running | **Transfers** |
| Otherwise | **Files** |

Priority is that ordered list. Detecting a localhost URL is not enough for Preview: the user must open Preview once (switcher or command palette). Jupyter notebook preview and Excel/table preview remain Files capabilities; they are not separate Inspector views.

## Reader pane

Opening a file from Files, Changes, a terminal path, or a completed transfer inserts a `reader` leaf to the right of that session’s terminal (40% terminal / 60% reader). One reader per session; history lives on `‹ ›` and the filename menu. The terminal stays visible. Closing the reader (✕ or ⌘W while focused) restores the terminal to full width. The pane counts toward the four-split cap; a full layout toasts “Split is full” instead of opening.

When the extra column would make the terminal unusable, the Inspector docks as an overlay (`⌘⇧\\` still recalls it). Session switch keeps each reader’s layout and drafts mounted. SSH reconnect re-fetches the same path on the new binding.

Auto-switch is restrained:

- It never runs after the user has chosen a view by hand.
- It never yanks the Inspector away from a workspace file the user is reading. In that case it shows a quiet “Show” hint instead of forcing the jump.
- Switching sessions resumes follow.

### Manual hold

Choosing a view from the switcher, ⌘K, hint bars, or Files transfer entry holds the Inspector on that view. The hold lasts until the user switches sessions. There is no Auto / Locked chrome or command-palette toggle; the hold is silent.

## Views

| View | Availability | Scope | Purpose |
|---|---|---|---|
| Changes | Local and SSH sessions | Repository profile | Read-only staged, unstaged, and untracked review |
| Files | Local and SSH sessions | Session or active SSH binding | Browse, search, safely preview/edit, and start SSH transfers |
| Preview | Local and SSH sessions | Session/source | Isolated workspace-bound loopback WebView |
| Transfers | SSH sessions | Logical session | Upload/download progress, cancellation, and recovery |
| Forwarding | SSH sessions | Active SSH binding | Local, dynamic, and reverse port forwarding |

⌘K reaches every view (`Open changes` / `Open files` / `Open Preview`, plus SSH `Open Transfers` / `Open Forwarding`). When no longer valid, stored legacy tab values fall back to Changes.

Remote file properties remain a Files context action. Connection diagnostics remain available through the SSH diagnostic flow, and known hosts remain under Settings → SSH; neither is a separate Inspector view.

## Product boundary

- Changes remains read-only: no stage, commit, push, or destructive Git actions.
- Files preserves local workspace containment, SSH binding checks, conflict-checked writes, and transfer recovery.
- Preview preserves source binding, navigation restrictions, WebView isolation, and explicit SSH tunnel boundaries.
- Transfers and Forwarding are hidden without an SSH context and reject stale transport generations.
- The Inspector does not keep per-session notes, activity timelines, or a fixed overview/dashboard.

Legacy snapshots may still contain retired Inspector tab names or a session `note` field. Snapshot sanitization ignores unknown session fields and maps invalid tabs to Changes; there is no user-visible migration or cleanup action. The silent manual hold and “Preview opened” are runtime UI and are not persisted.
