# Accessibility manual QA

Run these checks with a debug or release build connected to a disposable SSH host. Never accept a host-key fingerprint until it has been verified through a trusted channel.

Test exactly `01a18905bba7b82f7b10400e636c83d2a0e30c78`, not a moving branch. Verify it before testing with `git checkout --detach 01a18905bba7b82f7b10400e636c83d2a0e30c78 && test "$(git rev-parse HEAD)" = "01a18905bba7b82f7b10400e636c83d2a0e30c78" && git merge-base --is-ancestor ab186525eec229df8a4805c6b66c987af39c89f1 HEAD`. Prepare two disposable SSH hosts (one target and one loopback-listening bastion), a disposable `known_hosts` entry, a config fixture with direct/routed/rejected aliases, a large remote directory, and non-sensitive local files/folders. Do not use production credentials or hosts.

Windows and Linux SSH/agent support remains experimental; record platform-specific failures rather than interpreting this checklist as a production-support claim.

## A–F feature acceptance matrix

| Flow / feature | Preconditions | Keyboard operation path | Expected result | Negative / security scenarios |
|---|---|---|---|---|
| **A — lifecycle diagnostics** | Disposable direct and failed SSH endpoints | **SSH Connection → Connect → Inspector → Diagnostics → Copy report** | Typed stage, status, code, severity, hop role, and retry state describe the lifecycle; copied text is de-identified | Use a canary password/path/comment and an unknown backend failure. Neither UI nor copied report may expose raw errors, credentials, comments, physical PTY IDs, or transport generations |
| **A — known hosts** | Verified fingerprint and disposable removable entry | **Inspector → Known hosts → Refresh → Remove → Confirm remove** | List shows bounded host pattern, key type, and fingerprint; removal is a two-step action; persistence result is `saved`, `sessionOnly`, or `failed` | Reject a changed key; do not connect. `@cert-authority` is not removable. A stale revision and write failure show localized typed copy only |
| **B — profiles and single-hop ProxyJump** | Direct target, direct jump, routed target; duplicate/missing/routed jump fixtures | **SSH Connection → Quick connect → Direct or ProxyJump profile → Target-hop authentication / Jump-hop authentication method → Connect** | Target and jump remain distinct, each prompt identifies Direct/ProxyJump/Target, and routed session metadata retains one secret-free jump endpoint | `profileMissing`, `jumpMissing`, `jumpAmbiguous`, and `jumpRouted` disable **Connect**. Cycles/multi-hop never flatten and never fall back direct. Switching to **Direct connection** discards jump credentials |
| **B — certificate and agent boundaries** | Private key + matching OpenSSH certificate; agent with ordinary, certificate, and optional hardware-backed key | Select **Private key** and both file pickers, or select **SSH Agent** | CertificateFile is paired with the selected key; agent certificates and hardware-backed keys work only through the platform agent | Password mode never reads key files or contacts the agent. No secret is saved. No native FIDO/CTAP/HID or PKCS#11 support is claimed; Windows agent unavailability is explicit |
| **B — config resolver/import diagnostics** | Fixture covering Include, Host, Match, tokens, Canonicalize, ProxyCommand, and Match exec | **SSH Connection → Refresh ~/.ssh/config → SSH config diagnostics → imported alias** | Available/skipped counts and each alias source/line/code/directive match the fixture; resolved host/user/port/route/key/certificate values reflect first-value rules | Refresh invalidates old selections immediately and stale async results do not return. ProxyCommand and Match exec are rejected and never executed; unsupported/cyclic routes remain fail-closed |
| **C — upload/download and Transfer Center** | Connected target, local file/folder, downloadable remote file, one cancellable large transfer | **Files → Upload file… / Upload folder…**, OS drop, **Inspector → Transfers → Cancel / Retry** | Buttons and drop create equivalent typed intents; folder intent contains directories and queued files; progress announces start, 10%/2-second cadence, cancellation, and one terminal state | Drop never opens/navigates the browser. Invalid manifest/binding fails before transfer. Reconnect never auto-resumes transfer. Toast and live region do not duplicate terminal announcements |
| **D — remote CRUD and metadata** | Disposable writable directory plus file, directory, symlink | Treeitem **Shift+F10 → New folder / Rename / Delete / View remote metadata** | Dialogs name the exact host/path, mutation reconciles typed state, metadata exposes kind/size/mode/owner/link information, and focus returns to the source treeitem | Escape makes no mutation. Stale token/revision, invalid name, permission failure, and symlink cases fail safely with typed copy; never follow an unsafe assumption or display raw backend text |
| **E — forwarding** | Connected SSH session; free ephemeral port and one occupied fixed loopback port | **Inspector → Forwarding → Local / Dynamic → Start → Stop** | Listener is visibly loopback-only; requested and actual ports are shown; port `0` reports its assigned port; keyboard controls are complete | No Remote or Agent forwarding controls. Non-loopback requests and invalid destinations fail. Fixed-port collision is not silently changed; errors use the typed allowlist |
| **E — reconnect** | Auto reconnect initially off; recreate-on-reconnect forwarding intent; interruptible transport | Enable **Auto reconnect** and **recreate on reconnect**, interrupt transport, then use **Reconnect** when requested | States move through `reconnecting` or `needsUserAction`; a replacement shell is clearly described; ephemeral old/new ports are announced | Never claim the old shell was restored, replay input, resume transfers, or reuse consumed credentials. `fixedPortUnavailable` remains explicit and a new trust/filesystem boundary creates a new session |
| **F — screen reader, dialogs, tree, drag/drop** | Screen reader enabled; large nested directory; active transfer and SSH prompts | **Settings → Appearance → Screen reader mode**; complete all dialog/tree/transfer tasks below without pointer | Setting persists and affects existing/new xterm instances; modal focus is trapped/restored; tree exposes one roving treeitem with correct hierarchy; every hover/drag action has a keyboard path | Escape chooses the safe outcome. Virtualization restores focus. State is not conveyed by color alone. Hidden controls, fake tree semantics, repeated announcements, and browser default drop navigation are absent |

## Shared setup and tasks

1. Start Tunara with the screen reader running. Open **Settings → Appearance**, enable **Screen reader mode**, close Settings, reopen it, and verify the switch remains on. Restart Tunara and verify it is still on.
2. In an existing terminal, run `printf 'tunara accessibility check\n'`. Verify the new output is announced after enabling the setting without reopening the terminal. Open a second terminal and verify its output is also announced.
3. Open **SSH Connection** using only the keyboard. Verify focus starts on **Host**, Tab and Shift+Tab remain in the dialog, the authentication choices expose radio state, and Escape closes the dialog and restores focus to its opener.
4. Trigger an unknown-host-key prompt against the disposable host. Verify the dialog announces its title, explanatory text, fingerprint, and hint; initial focus is on the safe **Cancel** action. Press Escape and verify it rejects rather than trusts the key and restores focus without activating an underlying command.
5. Trigger keyboard-interactive authentication. Verify its title/instructions and every prompt label are announced, hidden responses are not echoed, Enter submits, and Escape cancels and restores focus.
6. Open **Files** on a directory containing nested folders and files. Verify it is announced as the “Files and directories” tree, including level, position, set size, and collapsed/expanded state. Tab enters the tree once. Use Up/Down, Home/End, Right to expand/enter children, Left to collapse/return to a parent, and type letters to move by name. Enter opens the focused row. Shift+F10 (or the Context Menu key) opens the same actions as right-click; Escape closes menus and dialogs and restores the originating treeitem, including after scrolling a directory large enough to virtualize.
7. Drag an OS file and a folder over **Files**. Verify the dashed border, arrow, and “Drop files or folders…” text make the target visible without color alone. Drop and verify the browser does not navigate/open the item. Repeat with the keyboard-accessible **Upload file…** and **Upload folder…** buttons; both paths must produce the same typed transfer plan and use the authoritative session binding.
8. Open **Transfers**. Verify progress is not spoken for every backend event: expect start, each crossed 10% boundary or an update after two seconds, cancellation, and one terminal announcement. Cancel and retry from the keyboard.
9. On a remote file and folder, use Shift+F10 to reach rename/delete/new-folder and **View remote metadata**. Verify naming and confirmation dialogs expose their roles and full host/path, Escape restores the source treeitem, and metadata permissions/owner/link information remains keyboard reachable. Use only a disposable host for mutation checks.
10. Open **Diagnostics**, trigger a failed disposable SSH connection, and verify only typed stage/status/code values appear—never raw backend errors, passwords, paths, host comments, or transport identifiers. Copy the de-identified report and repeat the canary check. Press Escape and verify the Inspector returns to Overview.
11. Open **Known hosts**, refresh, and inspect host pattern, key type, and fingerprint. For a disposable manageable entry, activate **Remove**, verify the same button changes to an explicit confirmation, then confirm. Verify `@cert-authority` entries cannot be removed and stale-revision failures show only the localized generic error.
12. On a connected SSH session, open **Forwarding**. Using only the keyboard, create a Local listener with local port `0`, verify the announced/listed actual port, then stop it. Repeat with Dynamic (SOCKS5), and verify there are no Remote or Agent forwarding choices. Confirm every listener is visibly restricted to loopback. Enable **recreate on reconnect** on a disposable rule, interrupt the transport, and verify the reconnect status says Tunara is opening a replacement shell—not restoring the old shell—and says input and transfers are not replayed. For a fixed-port collision, verify the requested port is not silently changed; for an ephemeral rule, verify the old and new actual ports are announced. Trigger a typed failure canary and verify no raw backend text is exposed.

## Modal, menu, scope, touch, and narrow-layout execution

Run every row below once in the workspace presentation and once with the Inspector projected as a pure-mode overlay. Use a disposable SSH target and record the tested commit, viewport, input device, and screen reader. The terminal canvas context-menu path remains owned by the terminal Input Router; these checks target host UI only.

| Input / setup | Executable steps | Pass criteria |
| --- | --- | --- |
| Pointer | Right-click a sidebar session, remote Files row, transfer action, and forwarding/known-hosts action. Click outside, reopen, then press Escape. | The same app-owned menu opens at the pointer, remains inside the viewport, closes once, and returns focus to the invoking host control. Terminal selection/input is unchanged. |
| Keyboard | Focus each same control and press **Shift+F10**, then the hardware **Menu** key where available. Use Up/Down, Home/End, Enter/Space, and Escape. Open SSH, host-key, keyboard-interactive, and Files rename/delete dialogs; traverse with Tab/Shift+Tab. | Menus expose `menu`/`menuitem`, skip disabled items, and match pointer actions. Dialogs expose a name/description, focus a safe action or first field, trap focus, and restore the exact opener. Escape rejects/cancels rather than confirms. |
| Touch | Long-press a sidebar session for at least 550 ms without moving; repeat while moving more than roughly 10 CSS px. In Files tap the visible **More actions: _name_** overflow control. | Stationary long-press opens one menu; movement cancels it and ordinary scrolling continues. The explicit overflow action provides the same menu without timing or hover. No terminal-canvas long-press is intercepted by this host-UI primitive. |
| Stale binding | Open a remote Files menu and rename dialog, then force a reconnect before choosing an action. Repeat while Forwarding or Metadata has a pending refresh. | The old menu/dialog closes, old async results never repaint the new connection, and focus is restored only if no newer surface has claimed it. The Inspector scope changes from the old Connection identity to the replacement identity. |
| Scope declarations | Visit Overview, Changes, Files, Transfers, Metadata, Forwarding, Diagnostics, Known hosts, Preview, and Notes. Read the line below the tabs. Switch between two sessions, then reconnect one SSH session. | Every panel visibly states its title, scope (`Global`, `Profile`, `Session`, or `Connection`), and scope description. Known hosts stays Global; Diagnostics/Transfers stay logical Session; Forwarding/Metadata and connected remote Files use Connection. Session and binding changes remount the scoped panel and invalidate pending results. |
| Typed states | Induce loading, empty, and a recoverable failure in Files, Known hosts, Forwarding, and Preview. Activate Retry where offered and follow remediation text. | State is identified by text/role/icon rather than color alone; error copy includes a bounded recovery path; retry is keyboard reachable. A single loading announcement occurs and progress/live regions do not announce every backend event. |
| Narrow viewport | Resize to **320×480**, **390×844**, and **640×480**. Open each menu/dialog and every Inspector tab; in pure mode open and close the overlay. | Dialog content scrolls within `100dvh`; safe/cancel and primary actions remain reachable. Menus flip/clamp into view. Inspector tabs scroll horizontally, scope text wraps, panel content can scroll, and no close/retry/remediation action is clipped. Terminal minimum-size policy remains unchanged. |
| Titlebar device tabs | Open a local file and an SSH file with different hosts. With the sidebar open, Tab to the titlebar file tab; then hide the sidebar and open the device button. | The visible file tab announces local path or remote SSH + host + path. Only the current device’s files appear. The device button announces the current host; unsaved files on other devices are listed in the menu and are keyboard reachable. Pure Mode removes this chrome. |

For VoiceOver, Narrator, and Orca, perform the keyboard and scope rows using the platform commands below. Confirm that opening a menu/dialog announces its role and name once; moving between Inspector tabs announces the selected tab, visible title, and scope description without repeating unchanged transfer progress.

## VoiceOver — macOS

1. Toggle VoiceOver with **Command+F5** and enable Quick Nav if normally used.
2. Use **VO+Shift+Down Arrow** to interact with Tunara controls and **VO+Right/Left Arrow** to inspect names, roles, descriptions, and state.
3. Perform all shared tasks. In the terminal, verify xterm output is reachable without VoiceOver becoming trapped in repeated blank rows.
4. Record macOS version, VoiceOver verbosity settings, and any duplicated or missing announcement.

## Narrator — Windows

1. Toggle Narrator with **Windows+Ctrl+Enter**.
2. Use **Caps Lock+Right/Left Arrow** for item navigation and Narrator scan mode as appropriate; use standard Tab/arrow keys when testing application keyboard behavior.
3. Perform all shared tasks. Confirm the SSH modal’s name and description are read once and file tree levels and expanded state update exactly once.
4. Record Windows/Narrator version, scan-mode state, and any duplicated or missing announcement.

## Orca — Linux

1. Start Orca (`orca`) before Tunara. Use **Insert+Space** if settings need adjustment.
2. Use Orca navigation for reading, but standard Tab/Shift+Tab/arrows for the keyboard interaction assertions.
3. Perform all shared tasks. Confirm terminal output is exposed through AT-SPI and list/menu focus does not disappear during virtualized scrolling.
4. Record distribution, desktop environment, Orca version, and any duplicated or missing announcement.

## Flow F3 — ProxyJump/config/certificate/agent

1. Keyboard only: open SSH, Tab through profile search, refresh, diagnostics,
   target endpoint, Direct/ProxyJump selector, jump authentication, target
   authentication, certificate picker, advanced controls, Cancel, and Connect.
   Shift+Tab reverses the exact path; Escape closes and restores opener focus.
2. Expand **SSH config diagnostics**. Confirm the visible available/skipped
   counts match the profile list and every rejection exposes severity, alias,
   source, line, code, and directive. The support matrix must name bounded
   Include; Host; Match all/canonical/final/host/originalhost/user/localuser;
   first-value-wins; `~`, `~/`, `%%`, `%h`, `%n`, `%p`, `%r`, `%u`; and the
   HostName/User/Port/ProxyJump/IdentityFile/CertificateFile plus Canonicalize
   directives. It must say ProxyCommand and Match exec are never executed.
3. Select routed saved and imported targets, then edit **Direct or ProxyJump
   profile**. Exercise the exact rejected route states `profileMissing`,
   `jumpMissing`, `jumpAmbiguous`, and `jumpRouted`; each shows an alert,
   disables **Connect**, and never connects directly. Activate **Refresh
   ~/.ssh/config** while an imported routed target is selected: endpoint and
   route are invalidated immediately, and a stale result must not repopulate
   either selection.
4. Under **Target-hop authentication** and **Jump-hop authentication method**,
   exercise password, key/passphrase, keyboard-interactive, and agent
   independently. A config jump with no inferred method must require an
   explicit choice. Host-key and keyboard-interactive dialogs announce Direct,
   ProxyJump, or Target hop. Reject/cancel has safe initial focus and Escape
   rejects/cancels. Reopen the app and confirm neither hop's password or
   passphrase was saved.
5. In each hop's key mode verify private key plus optional CertificateFile. In agent mode
   verify normal keys, OpenSSH agent certificates, hardware-backed keys,
   macOS/Linux sockets, Windows unavailability, and no native FIDO/CTAP/HID or
   PKCS#11 controls/providers.

## High review closure checklist

### Automated evidence boundaries

The upload-mutation tests perform controlled reads and truncate/grow/same-length writes against real local file descriptors and exercise the production pre-commit validator, but they are **not** an end-to-end transfer through a real SFTP server or persisted journal. The multiplex cancellation test uses a controlled mock multiplex transport and production pending-open helper, not a real `russh` connection or `sshd`. Prompt focus tests run in the test DOM; focus behavior, assistive-technology announcements, and restoration in the real Tauri WebView still require the platform manual checks above. Do not report any of these three automated seams as real-SSH or real-WebView evidence.

| Issue | Fix | Automated test / gate |
| --- | --- | --- |
| P0 exact B2 and host-key decision contract | Merge exact B final ancestry and keep `HostKeyDecision` end-to-end through cancellation. | `git merge-base --is-ancestor ab186525eec229df8a4805c6b66c987af39c89f1 01a18905bba7b82f7b10400e636c83d2a0e30c78`; Cargo tests. |
| P1 folder transfer dependencies | Create destination root and directories in depth order before enqueueing files; preserve empty directories and fail closed on mkdir errors. | `tests/ui/file-explorer.test.tsx`, `tests/ui/transfer-intent.test.tsx`. |
| P1 download early EOF | Require transferred bytes to equal the initial size and revalidate source type, size, and permissions before commit; retain the partial on failure. | `early_download_eof_cannot_reach_commit`; Cargo tests. |
| P1 upload source mutation | Retain one opened source descriptor, require streamed bytes to equal the initial length, and revalidate descriptor identity, length, and content before publication; leave journal/partial recovery state on failure. | Real file reads with mid-stream truncate, grow, and same-length overwrite in transfer engine Rust tests. |
| P1 pending forwarding opens | Cancel only the pending channel open and asynchronously close a late channel; never shut down the multiplexed transport. | `tests/ssh-ipc-inventory.test.mjs`; forwarding Rust/UI tests. |
| P2 local folder traversal | Anchor Unix traversal at a root dirfd and open every child with `openat(O_NOFOLLOW)`; unsupported platforms fail closed. | Manifest symlink and traversal Rust tests. |
| P2 chmod proof | Report `Unsupported` when SFTP cannot prove a no-follow, identity-bound operation; never report `Applied` from pathname acknowledgement alone. | Remote metadata Rust and UI tests. |
| P2 IPC redaction | Map every registered SSH `Result<_, String>` command to a fixed allowlisted error class; retain typed-command exemptions only. | Static inventory plus production mapper serialization test `command_error_mapper_serialization_is_fixed_and_drops_every_canary`. |
| P2 known_hosts persistence | Serialize processes with an fd-owned lock, reread under lock, preserve external/revoked records, and distinguish pre-commit failure from committed durability uncertainty. | known_hosts/local-safe-write Rust tests; i18n parity. |
| P2 explorer expansion races | Bind each async expansion to logical/physical/generation/path/hidden-mode tokens and validate before every state write. | `tests/ui/file-explorer.test.tsx`. |
| P2 CRUD modal focus | Trap Tab/Shift+Tab, reject on Escape, and restore the originating tree item. | `tests/ui/file-explorer.test.tsx`. |
| P3 cancel tombstones | Use a TTL-bounded FIFO with one-at-a-time eviction instead of clearing all cancellation evidence. | `cancel_tombstones_evict_one_oldest_entry_and_expire`. |
| P3 journal cleanup | Verify and unlink the recorded partial relative to one parent dirfd with no-follow identity checks; unsupported platforms fail closed. | transfer-journal hash/identity Rust tests. |
| P3 reproducible manual QA | Pin the test SHA, verify exact B2 ancestry, mark Windows/Linux experimental, and omit unverifiable renderer fields. | Manual commands at the top of this document; `git diff --check`. |
| Second review: late prompt focus | Activate each permanently mounted focus trap only while its prompt exists, including empty-store startup followed by enqueue. | Host-key and keyboard-interactive late-enqueue Tab/Shift+Tab/Escape/default-focus/focus-restore UI tests. |
| Second review: forwarding result races | Bind list/start/stop requests to logical session, physical PTY, transport generation, request epoch, and component lifetime before every state write. | Deferred A/B generation success/rejection and stale mutation UI tests. |
| Second review: chmod consistency | Advertise chmod as `Unsupported`, disable Apply, and keep the registered command as a non-mutating typed contract. | Remote metadata Rust test and UI no-IPC consistency test. |
| Second review: explorer retry | Keep a typed per-path read error without caching an empty directory and allow an explicit retry. | Deferred rejection followed by successful Retry in `tests/ui/file-explorer.test.tsx`. |
| Second review: command ACL | Regenerate the Tauri ACL and require every one of the 27 added SSH commands to be registered, permitted, and generated. | `tests/ssh-ipc-inventory.test.mjs`; generated `acl-manifests.json`. |
| Second review: multiplex behavior | Route production pending opens through a cancellable helper, drop/close the late channel only, and retain sibling transport I/O. | `cancelling_pending_multiplex_open_closes_late_channel_only` with controlled multiplex I/O. |
| Third review: forwarding stop binding | Carry the complete binding through Local/Dynamic UI and IPC; hold an authoritative binding lease through exact rule/generation validation and cancellation. | Local/Dynamic payload UI tests, IPC inventory, and `stale_generation_stop_after_replacement_cancels_no_rule`. |
| Third review: typed transfer payload | Replace raw failed/unknown details in successful command responses with stable codes and fixed safe messages; retain final Err mapping. | `ok_transfer_response_serialization_redacts_every_private_message_canary` covers download-style, SFTP, path/key/agent/passphrase, and legacy-upload canaries. |
| Third review: generated schemas | Commit the default desktop/Linux schema pair rather than feature-benchmark desktop output. | Forced clean Cargo rebuild followed by fmt/check/clippy/test and an empty `git status --porcelain`. |

## Result template

```text
Platform / screen reader / version:
Tunara commit:
Screen reader setting persisted: PASS / FAIL
Existing + new terminal output: PASS / FAIL
SSH dialogs, Escape, focus restore: PASS / FAIL
Files ARIA tree + roving focus + context menu: PASS / FAIL
OS drop guard + keyboard upload parity: PASS / FAIL
Transfer Center announcement cadence: PASS / FAIL
Remote CRUD / metadata dialogs and focus restore: PASS / FAIL
Diagnostics redaction / de-identified copy / Escape: PASS / FAIL
Known hosts refresh / two-step removal: PASS / FAIL
Forwarding loopback / keyboard start-stop / reconnect notices: PASS / FAIL
ProxyJump fail-closed routes / independent hop auth: PASS / FAIL
Certificate and agent platform boundaries: PASS / FAIL
Config resolver diagnostics / refresh invalidation: PASS / FAIL
Notes / reproduction:
```
