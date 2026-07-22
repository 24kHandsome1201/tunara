# Testing

Tunara has three automated test suites that run from one command:

- **Frontend logic** — Node's built-in test runner over `tests/*.test.mjs`, importing TypeScript sources directly.
- **UI components** — Vitest + Testing Library in `tests/ui/`, running in happy-dom.
- **Rust** — in-module `#[cfg(test)]` blocks run by `cargo test`.

There is no end-to-end browser or Tauri webview harness. The Node suite is
deliberately constrained to pure logic so it can import `.ts` source with zero
build step; DOM-backed component behavior belongs in the separate Vitest suite.

## Running the tests

```bash
pnpm test        # Node frontend + UI components + Rust
pnpm test:node   # pure logic and source assertions only
pnpm test:ui     # UI typecheck + happy-dom component tests
```

The scripts in `package.json` expand to:

```jsonc
"test:node": "node --experimental-strip-types --test tests/*.test.mjs",
"test:ui":   "pnpm typecheck:ui && vitest run --config vitest.config.ts",
"test":      "pnpm test:node && pnpm test:ui && cargo test --manifest-path src-tauri/Cargo.toml"
```

`pnpm test` runs the suites in that order, so a Node or UI failure short-circuits
before `cargo test` runs. Node 22 is the development baseline
(`--experimental-strip-types` is what lets the Node runner load `.ts` files
without compiling them first).

To run a single frontend file:

```bash
node --experimental-strip-types --test tests/terminal-utils.test.mjs
```

To run a single Rust module's tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib ssh::auth
```

## Node frontend convention

`.mjs` tests import `.ts` source **directly** — no transpile, no bundler. `node --experimental-strip-types` erases the type annotations at load time and runs the result. The runner is `node:test` + `node:assert/strict`; nothing else is imported from outside the repo.

A minimal test looks like this:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { isMeaningfulCommand } from "../src/modules/terminal/lib/terminal-command.ts";

test("isMeaningfulCommand treats noise commands as not meaningful", () => {
  assert.equal(isMeaningfulCommand("ls"), false);
  assert.equal(isMeaningfulCommand("git status"), true);
});
```

Note the import: a **relative path** (`../src/...`) and the **`.ts` extension is required**. Tests live in `tests/` and reach into `src/` with `../src/...`.

## Hard constraints (what the Node runner can and cannot load)

The runner is plain Node with type-stripping. It is **not** Vite, not a browser, and not a Tauri webview. Three things are unavailable, and each rules out whole categories of module:

1. **No path alias / import map.** The app uses `@/*` → `./src/*` (defined in `tsconfig.json` and `vite.config.ts`). Node does not honor that mapping, so any module whose **runtime** imports go through `@/...` cannot be loaded by the runner — the import resolves to nothing and the file throws on load.
   - **Exception:** `import type { Foo } from "@/...";` is fine, because `--experimental-strip-types` deletes type-only imports before execution. The `@/` path never reaches Node's resolver. So a pure helper that only *type*-imports from `@/...` is still testable; one that *value*-imports from `@/...` is not.
2. **No DOM / `window` / `navigator`.** Anything that touches `window`, `document`, `matchMedia`, etc. at module top-level (i.e. during import) cannot load. A function that touches `window` only when *called* can still be tested if you avoid that path — see `tests/terminal-theme.test.mjs`, which deliberately skips `isDarkTheme("system")` because it reads `window.matchMedia`.
3. **No Tauri runtime.** `@tauri-apps/api`, the plugin packages, and IPC `invoke` do not exist in Node. A module that calls a Tauri plugin at import time is out.

Concrete examples of modules that are **out of scope** for the Node runner:

| Module | Why it can't load |
|--------|-------------------|
| `src/ui/formatShortcut.ts` | Calls `platform()` (`@tauri-apps/plugin-os`) at module top: `const IS_MAC = platform() === "macos"`. No Tauri runtime → throws on import. |
| `src/state/ui.ts` | Value-imports from `@/ui/types`, `@/modules/config/config-bridge`, `@/modules/i18n`, etc., and also reads `window.innerWidth`. Both the alias and the DOM access disqualify it. |
| Most of `src/state/*` and React components | Pull in zustand stores wired to Tauri/DOM, or import siblings via `@/...`. |

The takeaway: **tests target pure logic.** When the logic you want to cover lives inside a component, a zustand store, or a Tauri command handler, the move is to **extract a pure function first** (string in → value out, no `@/` value imports, no `window`, no `invoke`) and test that. The codebase already does this — e.g. badge math lives in `src/ui/lib/dock-badge-state.ts` (tested), separate from the store that calls it; SSH bridge logic lives in `src/modules/ssh/*.ts` (tested), separate from the IPC wiring.

Note that not every file under `src/state/` is off-limits: `src/state/recent-commands.ts` and `src/state/recent-dirs.ts` have **no imports at all** and are imported and tested by `tests/lifecycle-replay.test.mjs`. The rule is about a module's imports and top-level side effects, not its directory.

## The "source-assertion" test style

A few tests don't import any source — they `readFileSync` the source (or shell-script) **text** and assert over it with regular expressions. They lock *structural* invariants that aren't expressible as a function call.

- `tests/agent-lifecycle-source.test.mjs` reads the shell integration scripts (`src-tauri/src/modules/pty/scripts/zshrc.zsh`, `bashrc.bash`, `config.fish`) and Rust files, and asserts they emit the right OSC escape sequences, define `claude()`/`codex()`/`droid()` wrapper functions, `chmod 600` their temp config, and never write to a predictable `/tmp/tunara-agent` path. These are properties of generated terminal bytes and shell behavior — there's no pure function to call.
- `tests/project-review-regressions.test.mjs` reads `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, the Homebrew cask, capability JSON, etc., and asserts version alignment, identifier (`dev.tunara.app`), capability permissions, and that orphaned modules stay deleted. These are cross-file release/config invariants.

Use this style **only** when the thing under test is text/structure that has no callable surface: shell scripts, escape-sequence emission, release-metadata alignment, capability manifests, "this file must not come back." For anything with a real function boundary, import and call it instead — regex-over-source tests are brittle and should be the exception.

## Rust side

Rust tests are in-module: a `#[cfg(test)] mod tests { ... }` block at the bottom of the file under test, run by `cargo test --manifest-path src-tauri/Cargo.toml`.

### Env-mutation caveat (parallel threads, one process)

`cargo test` runs tests on **multiple threads inside a single process**. Mutating process-global env with `std::env::set_var` races every other test in flight. The pattern in this repo is to **read** the environment, never set it:

- `src-tauri/src/modules/util.rs` — the `expand_tilde` tests read `$HOME` (falling back to `$USERPROFILE`) and assert tilde expansion against it. The test comment is explicit: *"Read (don't mutate) HOME to avoid racing other parallel tests."* If `HOME` is unset, the test returns early rather than fabricate one.
- `src-tauri/src/modules/ssh/auth.rs` — the `expand_tilde_handles_bare_and_prefixed` test uses `dirs::home_dir()` (a read) and checks that bare `~` and `~/...` expand under the real home.

If you genuinely need a controlled environment, derive paths from the real home or a temp dir instead of overwriting env vars.

### Filesystem fixtures

Two patterns appear, depending on what the code under test enforces:

- **Temp dir under the *real* home** — `src-tauri/src/modules/ssh/sftp.rs`. `validate_download_target` confines downloads to under the home directory, so the test fixtures *must* be created inside home (`dirs::home_dir().join(".tunara-sftp-test-...")` with a nanosecond-unique suffix), and `std::env::temp_dir()` is used as a deliberate **negative** case (it lives outside home on macOS, so a `/tmp/...` target must be rejected). Fixtures are cleaned up with `fs::remove_dir_all`; the `~/.ssh` sensitive-dir test skips itself if `~/.ssh` doesn't exist rather than failing on CI.
- **Plain temp dir** — `src-tauri/src/modules/config.rs`. Config has no home-confinement requirement, so `temp_config_path`/`temp_named_config_path` build a nanosecond-unique path under `std::env::temp_dir()`, write fixture TOML there, exercise load/migrate/clamp/repair, and `fs::remove_dir_all` the root afterward.

Both use a `SystemTime::now()` nanosecond suffix so parallel tests never collide on a path.

## How to add a test

**Frontend (`tests/*.test.mjs`):**

1. If the logic is buried in a component or a store, **extract a pure function first** — string/value in, value out, no `@/` *value* imports, no `window`, no Tauri `invoke`. Put it in a `lib/` file next to its module.
2. Create `tests/<name>.test.mjs`.
3. `import test from "node:test";` and `import assert from "node:assert/strict";`.
4. Import the source with a **relative path and `.ts` extension**: `import { fn } from "../src/.../file.ts";`.
5. Run `node --experimental-strip-types --test tests/<name>.test.mjs`, then `pnpm test:node` to confirm nothing else broke.
6. Only reach for the `readFileSync` + regex style if the invariant is over file *text* (shell scripts, release metadata, capability JSON) with no callable surface.

**Rust (`#[cfg(test)] mod tests`):**

1. Add the `#[cfg(test)] mod tests { use super::*; ... }` block at the bottom of the module under test (or add a `#[test]` fn to the existing one).
2. **Read** env, never `set_var` — derive from `dirs::home_dir()` / `$HOME` / `temp_dir()`.
3. For filesystem fixtures, use a `SystemTime::now().as_nanos()` unique suffix and `fs::remove_dir_all` cleanup. Put the fixture under the real home only if the code enforces home-confinement; otherwise `std::env::temp_dir()`.
4. Skip (early `return`) instead of failing when a precondition like `~/.ssh` is absent on CI.
5. Run `cargo test --manifest-path src-tauri/Cargo.toml`.

Before opening a PR, run the full gate from [`CONTRIBUTING.md`](../CONTRIBUTING.md): `pnpm typecheck`, `pnpm build`, `cargo fmt --check`, `cargo clippy ... -D warnings`, and `pnpm test`.

## Future: visual smoke

End-to-end browser/Tauri automation (Playwright or similar) is intentionally
**not** in scope today. The happy-dom suite covers component behavior, but the
meaningful runtime surface is still the Tauri webview inside a signed macOS
bundle.

Until a lightweight visual runner exists, treat the release bundle as the manual
smoke gate. See also [`VISUAL_QA.md`](./VISUAL_QA.md).

### macOS bundle verification checklist

Run after UI chrome or shell-tint changes:

```bash
pnpm build
pnpm typecheck
pnpm test:node
./node_modules/.bin/tauri build --bundles app
open -na src-tauri/target/release/bundle/macos/Tunara.app
```

Then confirm:

1. **Titlebar** — traffic lights and custom controls share one row; no extra
   blank space under the overlay titlebar.
2. **Shell tint** — sidebar, review panel, and titlebar match the active theme.
3. **Narrow viewport** — hide the sidebar; inspector tabs and overlays remain
   usable around 960px width.
4. **Glass fallback** — with reduced transparency, opaque tokens still read
   clearly over the terminal.
5. **Terminal idle** — unfocus the window for a minute, refocus, and confirm
   glyphs are not stale (WebGL atlas rebuild path).

`pnpm tauri dev` can look correct while `/Applications/Tunara.app` or an older
release bundle is still wrong, because release apps ship their embedded static
frontend. Always verify the bundle that will actually be installed.

## Current test files

The full set of frontend test files changes often; treat `ls tests/*.test.mjs`
as the source of truth rather than a static list. The categories below cover
the main themes by filename prefix.

### Frontend (`tests/`)

- **Agent lifecycle and semantics** (`agent-*`, `*-semantics-source`): Agent
  registry invariants, session summaries, timeline model, shell-integration
  OSC emission, and per-agent (claude/codex/opencode/aider/pi) source-assertion
  suites.
- **Terminal** (`terminal-*`, `local-terminal-*`): control-sequence stripping,
  command classification, theme math, buffer reads, blocks menu, paste
  protection, output buffering, WebGL atlas, and local CWD discovery.
- **Editor and file preview** (`editor-*`, `file-preview-*`, `markdown-*`,
  `dirty-draft-*`, `phase2-*`): draft guard, scroll position, markdown
  reader/syntax, safe-write contracts, and the Phase 2 editor surface.
- **File explorer** (`file-explorer-*`): remote root resolution and search.
- **SSH and remote** (`ssh-*`): failure classification, host profile
  serialization, write reconciliation, command detection, and M2 safe-write
  gating.
- **Preview** (`preview-*`): capture contract and source modeling.
- **Persistence** (`persist-*`, `lifecycle-*`, `session-lifecycle`): snapshot
  persistence, session lifecycle replay, and workspace hydration.
- **Design and accessibility regression** (`design-*`, `compact-*`,
  `focus-trap-*`, `shell-tint-*`, `resize-handle`, `titlebar-tabs`): a11y
  policy, compact feedback layout, focus traps, shell tint contrast, and
  chrome structure.
- **Project-level regression** (`project-review-regressions`): cross-file
  release/config invariants (version alignment, identifier, capability
  permissions, deleted-module guards).
- **Misc pure logic** (`breadcrumbs`, `diff-parse`, `dock-badge-state`,
  `git-watch-refcount`, `sync-watches`, `workflow-*`, `ui-types`,
  `clipboard`, `elapsed`, `runbook`, `update-reminder`, `workspace-*`,
  `timeline`, `session-*`, `app-shell-layout`, `split-layout`,
  `presentation-mode`, `record-keys`, `destructive-confirm`,
  `new-terminal-directory`, `grep-group`, `i18n-core`): small pure-logic suites
  keyed to a single module.

The `tests/ui/` subdirectory holds Vitest + happy-dom component tests (run by
`pnpm test:ui`); `tests/visual/` holds visual/QA fixtures.

### Rust (`src-tauri/src/modules/`)

`#[cfg(test)] mod tests` blocks live alongside the code they cover. To list
the modules that currently have tests:

```bash
rg -l '#\[cfg\(test\)\]' src-tauri/src/modules
```
