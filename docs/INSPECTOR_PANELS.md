# Inspector panels

The Inspector is Tunara's contextual right rail. It keeps review, files, Preview, transfers, and forwarding close to the terminal without becoming a second dashboard or an IDE.

The container is [`src/ui/InspectorPanel.tsx`](../src/ui/InspectorPanel.tsx). Navigation is defined by [`inspector-navigation.ts`](../src/ui/inspector-navigation.ts), and scope labels come from [`inspector-scope.ts`](../src/ui/inspector-scope.ts). Only the active panel is mounted. On narrow windows the rail becomes an overlay; Pure Mode can project Files alone without changing the stored Inspector selection.

## Navigation

| Panel | Availability | Scope | Purpose |
|---|---|---|---|
| Changes | Local and SSH sessions | Repository profile | Read-only staged, unstaged, and untracked review |
| Files | Local and SSH sessions | Session or active SSH binding | Browse, search, safely preview/edit, and start SSH transfers |
| Preview | Sessions with an eligible source | Session/source | Isolated workspace-bound loopback WebView |
| Transfers | SSH sessions | Logical session | Upload/download progress, cancellation, and recovery |
| Forwarding | SSH sessions | Active SSH binding | Local, dynamic, and reverse port forwarding |

Changes and Files are the permanent primary tabs. Preview is normally in **More** and is promoted while a source is active. Transfers and Forwarding appear in **More** only for SSH sessions. When no longer valid, stored legacy tab values fall back to Changes.

Remote file properties remain a Files context action. Connection diagnostics remain available through the SSH diagnostic flow, and known hosts remain under Settings → SSH; neither is a separate Inspector tab.

## Product boundary

- Changes remains read-only: no stage, commit, push, or destructive Git actions.
- Files preserves local workspace containment, SSH binding checks, conflict-checked writes, and transfer recovery.
- Preview preserves source binding, navigation restrictions, WebView isolation, and explicit SSH tunnel boundaries.
- Transfers and Forwarding are hidden without an SSH context and reject stale transport generations.
- The Inspector does not keep per-session notes, activity timelines, or a fixed overview/dashboard.

Legacy snapshots may still contain retired Inspector tab names or a session `note` field. Snapshot sanitization ignores unknown session fields and maps invalid tabs to Changes; there is no user-visible migration or cleanup action.
