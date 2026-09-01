# Visual QA

Manual checks for macOS bundle chrome and shell rendering. Run these against the
**release bundle**, not only `pnpm tauri dev` — installed apps embed their own
static frontend.

## Build and open the bundle

```bash
pnpm build
pnpm typecheck
pnpm test:node
./node_modules/.bin/tauri build --bundles app
open -na src-tauri/target/release/bundle/macos/Tunara.app
```

Dev builds use `src-tauri/tauri.conf.dev.json` (`productName: "Tuna"`,
`identifier: dev.tunara.app.dev`) so they can run beside an installed Tunara
release without identity collisions.

## Release visual baseline

Capture the matrix below from the same release bundle before and after shell or
design-token changes. Keep terminal content identical between captures: Agent
TUIs draw their own chrome, so their ASCII boxes and prompts are not Tunara UI.

| State | Width | Theme | Evidence to compare |
|---|---:|---|---|
| One local terminal, sidebar open | 1280px | light + dark | titlebar alignment, active session, terminal remains dominant |
| Two split terminals | 1440px | light | active split marker, usable terminal rows, no overlapping controls |
| Changes inspector with files | 1440px | light + dark | tab hierarchy, diff contrast, resize handle |
| Clean and non-Git inspector | 1280px | light | compact empty state, no misleading full-panel placeholder |
| Remote SSH session | 1440px | dark | attention vs running status, remote tools in overflow |
| Compact shell | 640px minimum | light | sidebar overlay, terminal width, close/toggle hit targets |

For every capture, also verify keyboard focus for the sidebar session list,
Inspector switcher, Auto/Locked indicator, and close controls. A visual match does not
replace those interaction checks.

## Titlebar and traffic lights

- [ ] Native traffic lights sit on the overlay titlebar centerline (no large blank
      band below the lights).
- [ ] Custom titlebar controls in `Titlebar.tsx` align with the traffic-light
      row (`--h-titlebar: 36px` in `tokens.css`, `trafficLightPosition` in
      `tauri.conf.json`).
- [ ] Window drag region works; control buttons remain clickable.

## Shell tint and paper surfaces

- [ ] Appearance shows one “Terminal & interface color scheme” radio group with
      nine mutually exclusive choices; no separate Theme or Terminal palette
      selector remains.
- [ ] Every choice previews a miniature titlebar, sidebar, terminal, panel,
      borders, and text hierarchy rather than terminal lines alone.
- [ ] Selecting Catppuccin recolors both xterm and the shell immediately;
      selecting Light afterward restores the default light terminal and shell.
- [ ] System follows the OS appearance only while the System choice is active.
- [ ] Sidebar, review panel, and titlebar tints match the active theme preset.
- [ ] Sidebar, terminal, and inspector have distinct solid surface levels.
- [ ] Narrow the window: layout does not clip traffic lights or panel tabs.

## Narrow viewport

- [ ] Resize the native window to its 640px minimum and verify the sidebar is
      an overlay rather than consuming the terminal canvas.
- [ ] Sidebar can hide without leaving a dead resize gutter.
- [ ] Inspector views (Changes / Files / Preview) stay reachable at ~960px
      width.
- [ ] Command palette and overlays remain centered and scrollable.

## Solid-surface fallback

- [ ] With reduced transparency (macOS accessibility), all surfaces keep the
      same readable contrast because the shell does not depend on blur.
- [ ] If Terminal background is enabled, Reduce Transparency still shows the
      solid theme canvas; turning the setting off restores that canvas without
      deleting a custom photo.
- [ ] Terminal selection, diff highlights, and accent buttons stay legible.

## Regression guards

`tests/project-review-regressions.test.mjs` pins titlebar height and macOS
control offset. Update those assertions intentionally when the chrome contract
changes.
