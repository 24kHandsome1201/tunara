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
before `cargo test` runs. CI runs Node, UI, and Rust tests as independent steps
(`if: always()` for the latter two), so an earlier suite cannot hide later
failures. Node 24 is the development and CI baseline
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

## i18n dead-key audit

`scripts/i18n-audit.mjs` compares the flat keys in `src/modules/i18n/locales/en.json` and `zh-CN.json` against references in `src/` (and any matching string literals in `src-tauri/src`). Tunara's `t()` looks up the key as a single dictionary entry — nested objects in JSON would still flatten to dotted keys, but the shipped files are already flat. Interpolation is `{{name}}` in the *value*, not in the key; there is no pluralization API.

The scanner finds:

- Direct calls: `t("a.b.c")`, `t('a.b.c')`, `t(\`a.b.c\`)`, including `t as staticT` aliases and `const t = useT()`.
- Indirect key literals such as `titleKey: "diff.title"` (counted as used if they match a locale key).
- Dynamic templates such as `` t(`workspace.${kind}_error.title`) ``. Matching locale keys are classified as **dynamic** (not dead) and listed for human review.

```bash
pnpm i18n:audit                 # human-readable report
pnpm i18n:audit -- --json       # machine-readable buckets
pnpm i18n:audit -- --fail-on-dead
```

`--fail-on-dead` exits non-zero when unused keys remain. `tests/i18n-audit.test.mjs` always fails on locale-set drift and on referenced-but-missing keys. Dead keys are printed but do **not** fail `pnpm test:node` unless `I18N_FAIL_ON_DEAD=1` is set — other workstreams are still deleting features, and the integrator will tighten this after a single cleanup pass.

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
- **Canonicalized physical temp dir** — `src-tauri/src/modules/ssh/local_safe_write.rs` and `hosts.rs`. The writer walks every parent component from `/` with `O_DIRECTORY | O_NOFOLLOW`, so a fixture under macOS `/tmp` or `/var` (symlinks to `/private/...`) fails with `ENOTDIR` before the test body runs. Tests must `fs::canonicalize(std::env::temp_dir())` first so the walk only sees real directories. Linux `/tmp` is usually already physical; canonicalize is a no-op there.

All three use a `SystemTime::now()` nanosecond suffix so parallel tests never collide on a path.

### Real SSH regression matrix (`tests/ssh-matrix/`, cargo feature `ssh-matrix`)

Everything above is hermetic. The one exception is the **real-SSH regression matrix** — a set of Rust integration tests in `src-tauri/src/modules/ssh/matrix_tests/` that drive the production russh client (`SshSession`, `auth.rs`, `known_hosts.rs`, the SFTP commands and `ssh_fs_grep`) against two Docker OpenSSH containers. It is the release-gate evidence for the roadmap item "发布后的真实环境回归矩阵" and runs as the `ssh-matrix (docker)` job in `.github/workflows/ci.yml` on every PR.

**Gating.** The module is declared `#[cfg(all(test, feature = "ssh-matrix"))]`, so plain `cargo test --lib` (and `cargo clippy --all-targets`) never compiles it, needs no Docker, and stays hermetic. It only exists when you pass `--features ssh-matrix`, which is what `tests/ssh-matrix/run.sh` does.

**Prerequisites.** Docker with Compose v2 (`docker compose`), `ssh-keygen`, `ssh-agent`/`ssh-add`, and a Rust toolchain. Ports `2201` (target) and `2202` (jump) on `127.0.0.1` are used by default; override with `TUNARA_SSH_MATRIX_TARGET_PORT` / `TUNARA_SSH_MATRIX_JUMP_PORT` (read by both the compose file and the runner).

```bash
tests/ssh-matrix/keygen.sh                                                  # throwaway ed25519 + RSA client keys in tests/ssh-matrix/.generated/ (git-ignored)
docker compose -f tests/ssh-matrix/docker-compose.yml up -d --build         # build the Debian openssh-server image, start target + jump
tests/ssh-matrix/run.sh                                                     # waits for both hops, then runs the gated tests
tests/ssh-matrix/run.sh --nocapture                                         # extra args go to the test harness
tests/ssh-matrix/run.sh matrix_tests::remote_fs                             # a single scenario
docker compose -f tests/ssh-matrix/docker-compose.yml down -v --remove-orphans
```

`run.sh` compiles with your real `HOME`, then re-executes the test binary with `HOME` pointed at a fresh temp directory (also exported as `TUNARA_SSH_MATRIX_HOME`, which the harness asserts against `dirs::home_dir()`). That is what makes the host-key scenarios safe: `known_hosts.rs` reads/writes `$HOME/.ssh/known_hosts`, and the download sandbox confines to `$HOME`, so nothing in the matrix ever touches the developer's or the runner's real `~/.ssh`. The runner also starts a private `ssh-agent` holding only the fixture ed25519 key and exports its `SSH_AUTH_SOCK` for the agent scenario, then kills it and deletes the temp home on exit. The fixture passwords reach the tests only through `TUNARA_SSH_MATRIX_PW_PASSWORD` / `TUNARA_SSH_MATRIX_KBD_PASSWORD` (exported by `run.sh`); the Rust sources contain no credential literals, and the wrong-secret scenarios derive their bad password from the real ones at runtime.

**Topology** (`tests/ssh-matrix/docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `sshd_config`):

| Container | Reached as | Role |
|---|---|---|
| `target` | `127.0.0.1:2201` from the host, `target:22` from `jump` | every scenario ends here; owns `/srv/matrix/big` (9,990 files, a `NEEDLE-tunara` line in every 1000th) and `/srv/matrix/scratch/edit.txt` |
| `jump` | `127.0.0.1:2202` | ProxyJump hop; same image, no fixture data |

Both hops generate fresh host keys on every start (so TOFU is always a genuine first connect), and provision three users with `Match User` blocks that pin **exactly one** method each — a scenario cannot pass by falling back to a different mechanism:

| User | Shell | Only accepts | Credential |
|---|---|---|---|
| `keyuser` | `/bin/bash` | `publickey` (ed25519 **and** RSA both in `authorized_keys`) | `tests/ssh-matrix/.generated/client/id_{ed25519,rsa}` |
| `pwuser` | `/bin/zsh` | `password` | `TUNARA_SSH_MATRIX_PW_PASSWORD` (default `tunara-matrix-pw`) |
| `kbduser` | `/bin/bash` | `keyboard-interactive` (PAM) | `TUNARA_SSH_MATRIX_KBD_PASSWORD` (default `tunara-matrix-kbd`) |

**Scenarios** (one file each under `matrix_tests/`; every test uses its own `session_id` and unique remote paths so they run in parallel):

- `auth_matrix.rs` — `AuthMethod::Key` with ed25519 and with RSA (`identity_file`), `Password`, `KeyboardInteractive` (answers the PAM prompt through `resolve_keyboard_interactive_prompt` and asserts the prompt event came from the server with `echo=false`), and `Agent` via the runner's private agent. Each success asserts `id -un` and the `resolving → connecting → handshaking → authenticating → openingShell → ready` phase sequence; the negative cases (wrong password / wrong kbd answer) assert the failure is reported at the `authenticating` stage.
- `shells.rs` — bash (`keyuser`) and zsh (`pwuser`) with `shell_integration` on: the bootstrap line is filtered out of the terminal, OSC 133 prompt/command-done markers and the OSC 7 cwd report arrive, `$SHELL`/`$0` name the expected shell, and the flow-control credit loop (`ack_output`) keeps output moving.
- `host_key.rs` — first connect with `HostKeyPolicy::AcceptUnknown` persists a `[127.0.0.1]:2201` entry; a second connect matches without prompting or rewriting the file; `HostKeyPolicy::Prompt` covers accept+remember, accept-session-only (nothing written) and reject. **Mismatch**: the test learns the *jump* container's real key, writes it into `known_hosts` under a different alias for the *target* port (`localhost` vs `127.0.0.1`), connects to that alias and asserts `known_hosts.rs` refuses with a mismatch error and **no prompt** is offered; it then clears the store and reconnects to prove the target's own key is healthy. These tests serialize on a mutex because they share the single isolated `known_hosts` file.
- `proxy_jump.rs` — `SshSession::open_via_jump` (`jump` hop with `keyuser`, target reached as `target:22`): `uname -n` on the routed shell equals the target's and differs from the jump's, `SSH_CONNECTION` on the target shows the jump's address, and both hops emit their own `hop`-tagged phases. Failure naming the hop: wrong jump credentials → `RoutedOpenError::Jump(..)` and the target is never dialed; good jump + wrong target credentials → `RoutedOpenError::Target(..)`.
- `reconnect.rs` — passive disconnect: the shell runs `kill -9 $PPID` (its own sshd session process), the client observes `PtyEvent::TransportLost { reason: "transportClosed" }` then `Exit`, `SshSession::{transport_lost, is_closed, wait_closed}` agree and writes fail. Reconnect registers a new physical session for the **same logical session** with a new `transport_generation`; the old `SessionBindingV1` no longer resolves in `PtyState::get_for_ssh_binding`, a safe-write with the stale binding fails with `SSH_SFTP_WRITE_FAILED`, the new binding works, and no events from generation 1 leak after its close.
- `remote_fs.rs` — SFTP on `/srv/matrix/big` (~10k files): `ssh_fs_read_dir` returns exactly 9,990 entries (hidden filtering checked), `ssh_fs_read_file` reads a needle file and fails on a missing one, `ssh_fs_upload` streams progress and refuses to overwrite without `overwrite`, `ssh_fs_write_text_file` (safe write) succeeds with the fresh fingerprint and rejects a stale one, `ssh_fs_download` lands under `$HOME/Downloads` and refuses a path outside `$HOME`. Remote grep: `ssh_fs_grep` over the same directory finds exactly the `NEEDLE-tunara` files with correct relative paths and line numbers, honours `case_insensitive`, and each of 3 samples must finish under `TUNARA_SSH_MATRIX_GREP_BUDGET_MS`.

**Latency threshold.** The grep budget defaults to **3000 ms** per call. Remote grep is one `grep -rEIn` exec over ~10k small files on a warm container page cache, which measures well under a second on the GitHub `ubuntu-22.04` runner; 3 s leaves headroom for cold caches and noisy shared runners while still catching the regressions the roadmap item is about (per-file round trips, missing `--exclude-dir`, or output buffering stalls, all of which push a 10k-file search past several seconds). Raise it via `TUNARA_SSH_MATRIX_GREP_BUDGET_MS` only for slow local Docker VMs, never in CI.

**Where this can't run.** Docker on macOS needs a hypervisor (Colima/Docker Desktop); on hosts without virtualization the fixture cannot start, and the `ssh-matrix (docker)` Ubuntu CI job is the source of truth. Nothing in the regular `cargo test --lib` gate depends on it.

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
3. For filesystem fixtures, use a `SystemTime::now().as_nanos()` unique suffix and `fs::remove_dir_all` cleanup. Put the fixture under the real home only if the code enforces home-confinement. If the code walks parents with `O_NOFOLLOW`, canonicalize `temp_dir()` first (macOS `/tmp` is a symlink). Otherwise `std::env::temp_dir()` is fine.
4. Skip (early `return`) instead of failing when a precondition like `~/.ssh` is absent on CI.
5. Run `cargo test --manifest-path src-tauri/Cargo.toml`.

Before opening a PR, run the full gate from [`CONTRIBUTING.md`](../CONTRIBUTING.md): `pnpm typecheck`, `pnpm build`, `cargo fmt --check`, `cargo clippy ... -D warnings`, and `pnpm test`.
## Future: visual smoke

End-to-end browser/Tauri automation (Playwright or similar) is intentionally
**not** in scope today. The happy-dom suite covers component behavior, but the
meaningful runtime surface is still the Tauri webview inside a signed macOS
bundle.

Until a lightweight visual runner exists, treat the release bundle as the manual
smoke gate. See also [`VISUAL_QA.md`](./archive/VISUAL_QA.md).

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
2. **Shell tint** — sidebar, Inspector, and titlebar match the active theme.
3. **Narrow viewport** — hide the sidebar; Inspector switcher and overlays remain
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
  registry invariants, session summaries, shell-integration
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
  serialization, write reconciliation, command detection, file loop, and M2
  safe-write gating.
- **Sidebar grouping** (`sidebar-groups`, `session-attention`): local-vs-SSH
  group keys, OSC 7 cwd stability, and ⌘↩ attention jump.
- **Preview** (`preview-*`): source modeling, navigation, lifecycle, restart,
  tunnel, and ACL contracts.
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
  `clipboard`, `elapsed`, `update-reminder`, `workspace-*`,
  `session-*`, `app-shell-layout`, `split-layout`,
  `chrome-fade`, `record-keys`, `destructive-confirm`,
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
