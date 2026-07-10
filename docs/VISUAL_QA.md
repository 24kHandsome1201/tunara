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

## Titlebar and traffic lights

- [ ] Native traffic lights sit on the overlay titlebar centerline (no large blank
      band below the lights).
- [ ] Custom titlebar controls in `Titlebar.tsx` align with the traffic-light
      row (`--h-titlebar: 36px` in `tokens.css`, `trafficLightPosition` in
      `tauri.conf.json`).
- [ ] Window drag region works; control buttons remain clickable.

## Shell tint and paper surfaces

- [ ] Sidebar, review panel, and titlebar tints match the active theme preset.
- [ ] Sidebar, terminal, and inspector have distinct solid surface levels.
- [ ] Narrow the window: layout does not clip traffic lights or panel tabs.

## Narrow viewport

- [ ] Resize the native window to its 640px minimum and verify the sidebar is
      an overlay rather than consuming the terminal canvas.
- [ ] Sidebar can hide without leaving a dead resize gutter.
- [ ] Inspector tabs (Overview / Notes / Diff / Files) stay reachable at ~960px
      width.
- [ ] Command palette and overlays remain centered and scrollable.

## Solid-surface fallback

- [ ] With reduced transparency (macOS accessibility), all surfaces keep the
      same readable contrast because the shell does not depend on blur.
- [ ] Terminal selection, diff highlights, and accent buttons stay legible.

## Regression guards

`tests/project-review-regressions.test.mjs` pins titlebar height and macOS
control offset. Update those assertions intentionally when the chrome contract
changes.
