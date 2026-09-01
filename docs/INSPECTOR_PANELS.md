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

Priority is that ordered list. Detecting a localhost URL is not enough for Preview: the user must open Preview once (hint bar, switcher, or command palette). Jupyter notebook preview and Excel/table preview remain Files capabilities; they are not separate Inspector views.

Auto-switch is restrained:

- It never runs while the view is **Locked**.
- It never yanks the Inspector away from a workspace file the user is reading. In that case it shows a quiet “Show” hint instead of forcing the jump.
- Unlocking / returning to Auto, or switching sessions, resumes follow.

### Lock

Choosing a view from the switcher, ⌘K, hint bars, or Files transfer entry **locks** the Inspector on that view. Lock lasts until:

- the user switches sessions, or
- the user clicks **Locked** (or the command palette “Follow Inspector automatically”).

A quiet **Auto** / **Locked** pill sits next to the current view title. Auto is a label; Locked is a control that returns to Auto.

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

Legacy snapshots may still contain retired Inspector tab names or a session `note` field. Snapshot sanitization ignores unknown session fields and maps invalid tabs to Changes; there is no user-visible migration or cleanup action. Auto / Locked and “Preview opened” are runtime UI and are not persisted.
