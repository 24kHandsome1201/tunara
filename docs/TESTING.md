# Testing

Tunara has two test suites that run from one command:

- **Frontend** — Node's built-in test runner over `tests/*.test.mjs`, importing TypeScript sources directly.
- **Rust** — in-module `#[cfg(test)]` blocks run by `cargo test`.

There is no browser harness, no Vitest, no jsdom. The frontend suite is deliberately constrained to pure logic so it can import `.ts` source with zero build step.

## Running the tests

```bash
pnpm test        # frontend + Rust (what CI and PRs run)
pnpm test:node   # frontend only
```

The scripts in `package.json` expand to:

```jsonc
"test:node": "node --experimental-strip-types --test tests/*.test.mjs",
"test":      "pnpm test:node && cargo test --manifest-path src-tauri/Cargo.toml"
```

`pnpm test` is `pnpm test:node && cargo test ...` — the Node suite gates the Rust suite, so a frontend failure short-circuits before `cargo test` runs. Node 22 is the development baseline (`--experimental-strip-types` is what lets the runner load `.ts` files without compiling them first).

To run a single frontend file:

```bash
node --experimental-strip-types --test tests/terminal-utils.test.mjs
```

To run a single Rust module's tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib ssh::auth
```

## Frontend convention

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

## Current test files

### Frontend (`tests/`)

Pure-logic suites (import `.ts` source and call it):

| File | Covers |
|------|--------|
| `terminal-utils.test.mjs` | `stripTerminalControlSequences`, `cleanTerminalText`, `cleanTerminalLines` (`src/modules/terminal/lib/terminal-utils.ts`) |
| `terminal-command.test.mjs` | `isMeaningfulCommand` noise classification (`src/modules/terminal/lib/terminal-command.ts`) |
| `terminal-theme.test.mjs` | `isTerminalThemeDark`, `getTerminalTheme`, accent blending (`src/styles/terminalTheme.ts`) |
| `terminal-buffer-read.test.mjs` | `extractCommandFromOsc` OSC 133 decode (`src/modules/terminal/lib/terminal-buffer-read.ts`) |
| `agent-registry.test.mjs` | `AGENT_REGISTRY` / `AGENT_NAMES` / `AGENT_COMMANDS` / `AGENT_CODES` invariants (`src/modules/agent/registry.ts`) |
| `ui-types.test.mjs` | `formatSize`, `groupByDir` (`src/ui/types.ts`) |
| `terminal-blocks-menu.test.mjs` | `buildBlockContextMenuItems` (`src/modules/terminal/lib/terminal-blocks-menu.ts`) |
| `breadcrumbs.test.mjs` | `breadcrumbSegments` path collapsing (`src/ui/lib/breadcrumbs.ts`) |
| `diff-parse.test.mjs` | `buildMiniDiffRows`, `collectHunkTexts`, `filterRowsByQuery` (`src/ui/lib/diff-parse.ts`) |
| `dock-badge-state.test.mjs` | `decideBadge`, `createDockBadgeController`, `countUnread` |
| `git-watch-refcount.test.mjs` | `createWatchRefCount`, `normalizeRepoPath`, `sameRepoPath` |
| `sync-watches.test.mjs` | `diffWatchedDirs` (`src/app/lib/sync-watches.ts`) |
| `workflow-template.test.mjs` | `extractParams`, `applyParams`, `hasParams`, `sanitizeWorkflow` (`src/modules/workflows/template.ts`) |
| `ssh-logic.test.mjs` | `classifySshFailure`, `toProfile`/`toRaw`/`makeHostId`, one-shot `stashSshCredentials`/`takeSshCredentials` |
| `lifecycle-replay.test.mjs` | Agent lifecycle OSC parsing, run-state, command-palette filtering, paste protection, recent-commands/dirs, and more (broad pure-logic suite) |

Source-assertion suites (`readFileSync` + regex over text):

| File | Covers |
|------|--------|
| `agent-lifecycle-source.test.mjs` | Shell integration scripts + Rust agent/hook files: OSC emission, agent wrapper functions, `chmod 600`, no predictable `/tmp` paths |
| `project-review-regressions.test.mjs` | Cross-file release/config invariants: version alignment, `dev.tunara.app` identifier, capability permissions, deleted-module guards |

### Rust (`src-tauri/src/modules/`)

`#[cfg(test)] mod tests` blocks live in:

```
agent/hooks.rs        agent/preflight.rs    agent/wrapper.rs
config.rs             fs/grep.rs            fs/mod.rs
git/commit.rs         git/mod.rs           git/watcher.rs
process/error.rs      process/runner.rs     pty/shell_init.rs
resolver/mod.rs       ssh/auth.rs          ssh/hosts.rs
ssh/known_hosts.rs    ssh/sftp.rs          util.rs
```
