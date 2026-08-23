# Terminal interaction triggers (v1)

Status: accepted, 2026-08-13.

## Decision

The first release uses a deliberately small model instead of a general
multi-binding/conditional-trigger schema:

- Secondary click has three presets: `smart` (default), `menu`, and `disabled`.
  Smart opens the Tunara menu only when terminal mouse reporting is off; the
  configured Host Modifier overrides reporting. `menu` always claims the
  gesture and is explicitly high-risk. `disabled` never claims secondary click
  for Tunara, but still forwards it when a TUI has enabled mouse reporting.
- Gesture ownership is latched at secondary-button `mousedown` and retained for
  `mouseup` and `contextmenu`, including both WebKit event orders. A TUI-owned
  `contextmenu` is stopped in capture phase so xterm's
  `rightClickSelectsWord` host behavior cannot run after PTY mouse events.
- Menu opening and direct actions are separate. Existing `[keybindings]` gains
  one optional menu binding plus Copy Selection and Safe Paste. New Terminal
  and Split keep their existing actions and bindings. Each action has at most
  one configurable binding in v1; conflicts are rejected rather than resolved
  by declaration order. Native paste shortcuts stop xterm key processing but
  preserve the browser default, so Wry emits one trusted `paste` event carrying
  `clipboardData`; the shortcut keydown itself is never forwarded to the PTY.
  Other handled terminal shortcuts cancel the browser default. A conflict
  introduced by hand-edited TOML is consumed without executing either terminal
  action or forwarding the chord to the PTY. Plain/Alt-only terminal chords are
  treated as risky because they can steal ordinary shell or TUI input.
- Shift+F10 and the ContextMenu key remain fixed recovery paths. Command
  Palette, Titlebar, and Sidebar actions remain available even if configurable
  triggers are disabled, and the exact unmodified recovery chords cannot be
  reassigned in Settings or preempted by hand-edited app bindings. Modified
  variants such as Ctrl+Shift+F10 remain independently configurable.
- Every paste path uses the binding-aware terminal action registry and the
  existing async safe-paste confirmation. Menu, shortcut, and command-palette
  paste read text through Tauri clipboard-manager (capability:
  `clipboard-manager:allow-read-text`) — not `navigator.clipboard.readText()`.
  Keyboard paste instead consumes the native event's `clipboardData`. The target
  identity and bracketed paste mode are captured before awaiting clipboard
  access or confirmation; even a safe single-line native paste is rejected if
  its captured target is already stale.

## Persistence and compatibility

`[terminal_interactions]` is versioned but initially stores only
`secondary_click`. The existing `appearance.terminal_host_modifier` remains the
source of truth so old configurations need no field migration. Existing custom
`[keybindings]` tables are preserved and missing new actions receive platform
defaults in the frontend. Unknown TOML keys are retained by the backend merge;
a table with a future version is not rewritten by this version of Tunara.

## Deferred

Arbitrary multi-bindings, user-authored conditions, direct mouse actions,
double/triple click, long press, middle/side buttons, native trackpad gestures,
and workspace overrides are deferred. They require hardware/WebView evidence
and a real prioritization model; none are enabled by default in v1.

Automated platform-mapping tests cover macOS, Windows, and Linux defaults, but
do not replace real WKWebView, WebView2, WebKitGTK, mouse, and trackpad testing.
