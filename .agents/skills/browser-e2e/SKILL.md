---
name: tunara-browser-e2e
description: Run Tunara's real React frontend in headed Chromium with the repository's mocked Tauri backend for visual and interaction checks.
---

# Tunara browser UI testing

Use the requested worktree, not another checkout. Consult `docs/TESTING.md`,
`e2e/vite.config.ts`, and `e2e/mock-backend.ts` before testing.

## Devin Secrets Needed

None for the local mocked-backend harness. Native SSH and filesystem integration
are separate coverage and must not be claimed from this harness.

## Launch

With project dependencies and Chromium installed:

```sh
pnpm exec vite build --config e2e/vite.config.ts
pnpm exec vite preview --config e2e/vite.config.ts
```

The default preview address is `http://127.0.0.1:1430`.
Launch headed Playwright Chromium with a CDP port for computer accessibility
queries and Playwright assertions. Use `viewport: null` and maximize the native
window before recording. Keep the owning Playwright process alive while helper
scripts connect over CDP. Use finite locator timeouts in those scripts.

For baseline comparisons, a separate temporary source snapshot plus dependency
symlink and preview `--port 1431` avoids changing the feature checkout.

## Fixtures and UI details

- Use `window.__TUNARA_E2E__.emitPtyOutput` and `openPtyIds`; do not mutate the
  application's stores to fabricate the state being verified.
- Resolve the live PTY ID from the mock state. IDs increment after closing a
  terminal; the second visible terminal need not be PTY ID 2.
- A running command fixture can emit OSC 133 A/B prompt markers followed by
  `C;sleep 60`. Complete it with `D;1` for failure. Wait for the sidebar state,
  because terminal output parsing is asynchronous.
- Hover a session card before clicking its hover-only close button.
- Global search uses role `combobox`, not `textbox`.
- In SSH advanced mode use a complete target such as `deploy@example.test`.
  A missing user can keep Connect disabled even after correcting Port.
- The stock filesystem mock can leave Files loading if resolving `~` does not
  yield an absolute path. For an authorized file-action test, wrap the mock IPC
  delegate to resolve `~` to `/home/e2e`, return a valid file entry from
  `fs_read_dir`, and reject the relevant action such as `open_in_editor`.
  Trigger the real UI action (file's More actions → Open with VS Code), not a
  synthetic toast. Restore/reset the delegate afterward and disclose the fixture.
- Theme/locale changes should use Settings UI. Preferences may reset on reload
  in the mock; verify the theme rather than assuming persistence.

## Linux and localization

- Source `~/.nvm/nvm.sh` when pnpm or Node is not on PATH.
- If Playwright reports its browser executable is absent, run
  `pnpm exec playwright install chromium`.
- Before recording non-Latin UI, check `fc-list :lang=zh` and visually confirm
  glyphs; minimal Linux images may have no CJK fonts. Install Noto Sans CJK (or a
  user-local copy under `~/.local/share/fonts`), run `fc-cache -f`, and restart
  Chromium.
- Use a readable desktop resolution before maximizing; a large virtual desktop
  scaled into the recording makes text illegible.
- Settings segmented language and renderer options have `role="radio"`, not
  `button`. Settings is one scrollable document; several controls keep
  `settings.appearance.*` keys but live under the Terminal section.
- Selecting Auto renderer with a terminal open can finish the GPU check
  immediately; assert the real status instead of expecting the pending text.
- The explorer hidden-file control uses a native `title` tooltip (the titlebar
  uses a custom `[role=tooltip]`). Capture native tooltips with a desktop
  screenshot; page screenshots omit them.
- CDP screenshots during overlay entrance transitions may blur; wait for stable
  rendering first.

## SSH fixture boundaries

- The stock mock may not implement `ssh_open_v2`; submitting the SSH dialog can
  yield a disconnected session rather than a ready SSH terminal.
- A disconnected SSH session still shows forwarding heading and empty-state
  copy, but that does not prove active forwarding or SSH functionality.
- When extending an authorized mocked backend, intercept IPC command contracts
  rather than mutating frontend stores, and disclose the fixture boundary.

## Evidence

Assert both visible screenshots and semantic state. Wait for transitions before
comparing computed colors; screenshot `animations: "disabled"` finishes finite
entrances but is not evidence that reduced motion works. For reduced motion,
inspect the live attribute, computed animation name, iteration count and
`getAnimations()` separately before capture.

If card pointer selection behaves unexpectedly, compare a keyboard Enter on the
same focused card and run the same sequence on the baseline before calling it a
feature regression. Reinstall error listeners after reload/navigation or persist
them with an init script; do not claim full console coverage from a lost array.
