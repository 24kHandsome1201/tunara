# Frontend performance budget

README promises an installer of about **30 MB** and that the app **opens nearly instantly**. This document is the frontend half of that promise: a measured Vite production bundle, a gzip budget with a 5% growth cap, and the lazy-load / benchmark-hook work that landed on `redesign/perf-lazy`.

This orb cannot produce a macOS `.app` / `.dmg`, so **installer size and real cold-start latency are not verified here**. The guardrail is the webview JS (and CSS, for context) that Tauri loads.

## How to run

```bash
pnpm test:bundle
```

That is `pnpm build && node --experimental-strip-types --test tests/bundle-budget.test.mjs`.

`pnpm test` / `pnpm test:node` do **not** rebuild. If `dist/` is missing, the budget file skips and tells you to build first; if `dist/` is present (CI already runs `pnpm build` before Node tests), the same assertions run against that tree.

CI (`.github/workflows/ci.yml`) runs the budget file **without** a second `pnpm build`, reusing `dist/` from the preceding frontend build step.

Gzip in the test matches Vite's reporter: `promisify(gzip)` from `node:zlib`.

## Baseline

Measured **2026-09-02** on `redesign/perf-lazy` after gating benchmark hooks and lazy-loading `Settings`, `SshConnect`, and `DiffPanel`. `pnpm build`, Vite 7.3.6, 320 modules. `vite.config.ts` `manualChunks` still splits `react` and `xterm`. `build.modulePreload.resolveDependencies` keeps only those two vendor chunks on the HTML preload list.

`src/main.tsx` is a boot stub: it loads fonts/CSS, then `import("./app/App")`. `index.html` modulepreloads `react-*.js` and `xterm-*.js`. Async chunks (`FilePreview`, `TransferCenter`, `ForwardingPanel`, `Settings`, `SshConnect`, `DiffPanel`) are **not** preloaded.

### Before / after (gzip)

| Chunk | Before (`origin/redesign/integration`) | After (`redesign/perf-lazy`) | On first load? |
| --- | ---: | ---: | --- |
| `App-*.js` | 187 295 B (188.51 kB Vite) | **170 176 B** (171.29 kB Vite) | yes (dynamic import from boot) |
| `Settings-*.js` | in App | 7 931 B | **lazy** |
| `SshConnect-*.js` | in App | 7 179 B | **lazy** |
| `DiffPanel-*.js` | in App | 5 670 B | **lazy** |
| Total `dist/assets/*.js` | 416 567 B | 420 242 B | |

App gzip dropped **17 119 B** (−9.1%). Total JS gzip rose **3 675 B** because the three overlays are now extra chunks (shared-vendor duplication + chunk headers) rather than DCE’d out; they are not on the first-load path.

Vite reporter kB is `bytes / 1000`. Exact gzip bytes used by the test:

| Guard | Bytes | × 1.05 budget |
| --- | ---: | ---: |
| Entry = `App-*.js` | 170 176 | 178 684 |
| Total `dist/assets/*.js` | 420 242 | 441 254 |

The HTML entry (`main-*.js`, 1.55 kB gzip) is too small to be a useful cap. The budgeted **entry chunk** is the application bundle `App-*.js`.

Startup JS actually fetched before the shell paints (boot + modulepreload + App) is **378.63 kB gzip** (main + react + xterm + App, Vite reporter). Lazy overlay / Inspector / preview chunks add the remaining ~44 kB gzip if those views open.

### JS chunks (after)

| Chunk | Raw | Gzip | On first load? | Main sources |
| --- | ---: | ---: | --- | --- |
| `main-*.js` | 2.97 kB | 1.55 kB | yes (HTML entry) | `src/main.tsx` |
| `App-*.js` | 588.07 kB | 171.29 kB | yes (dynamic import from boot) | app shell, terminals, overlays chrome, i18n, Tauri plugins, Zustand |
| `react-*.js` | 192.51 kB | 60.35 kB | yes (modulepreload + `manualChunks`) | `react`, `react-dom`, `scheduler` |
| `xterm-*.js` | 545.23 kB | 145.44 kB | yes (modulepreload + `manualChunks`) | `@xterm/xterm` + every addon |
| `FilePreview-*.js` | 58.98 kB | 17.72 kB | **lazy** | `FilePreview.tsx`, markdown/notebook/tabular preview |
| `Settings-*.js` | 31.98 kB | 7.96 kB | **lazy** | Settings overlay + `overlays/settings/*` |
| `SshConnect-*.js` | 23.96 kB | 7.20 kB | **lazy** | `SshConnect.tsx` |
| `DiffPanel-*.js` | 17.01 kB | 5.68 kB | **lazy** | `DiffPanel.tsx` |
| `ForwardingPanel-*.js` | 10.06 kB | 2.90 kB | **lazy** | `ForwardingPanel.tsx` |
| `TransferCenter-*.js` | 8.85 kB | 2.90 kB | **lazy** | `TransferCenter.tsx` |
| **Total JS** | **1 479.62 kB** | **422.99 kB** | | |

### CSS and fonts (not in the JS test)

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `main-*.css` | 112.32 kB | 39.24 kB |
| `xterm-*.css` | 3.60 kB | 0.99 kB |
| JetBrains Mono (latin/ext/cyrillic/greek/vietnamese, 400–700, woff + woff2) | ~400 kB files on disk | n/a (woff2 already compressed) |

### Feature → chunk map

| Surface | Chunk today | Code-split? |
| --- | --- | --- |
| xterm + fit / search / serialize / web-links / image / webgl | `xterm-*.js` | yes, but **modulepreloaded** on every launch |
| `FilePreview` + `markdown-reader` / `markdown-syntax` / `notebook` / `tabular-preview` | `FilePreview-*.js` | **yes** — `lazy()` in `ReaderPane.tsx` |
| `DiffPanel` | `DiffPanel-*.js` | **yes** — `lazy()` in `InspectorPanel.tsx` |
| `SshConnect` | `SshConnect-*.js` | **yes** — `lazy()` in `App.tsx` |
| Settings overlay + `overlays/settings/*` | `Settings-*.js` | **yes** — `lazy()` in `App.tsx` |
| `TransferCenter` | `TransferCenter-*.js` | **yes** — `lazy()` in `InspectorPanel.tsx` |
| `ForwardingPanel` | `ForwardingPanel-*.js` | **yes** — `lazy()` in `InspectorPanel.tsx` |

Both locale JSON files (`en.json` ~72 kB, `zh-CN.json` ~71 kB source) are inlined into `App-*.js`.

## Budget rule

- After a production `pnpm build`, `App-*.js` gzip ≤ **170 176 × 1.05**.
- Sum of gzip of every `dist/assets/*.js` ≤ **420 242 × 1.05**.
- `App-*.js` must not contain the string `Benchmark` (the GUI harness lives in a dynamic `benchmarks/` chunk that a normal production build never emits).
- Re-measure and update the constants in `tests/bundle-budget.test.mjs` (and the tables here) only when the growth is intentional. Record date + commit.

This does **not** replace a macOS installer budget. 30 MB is a Tauri/Rust/WebView packing claim; keep it on the release checklist.

## Lazy-load recommendations (remaining)

| Rank | Module | Why | Est. gzip out of `App-*.js` |
| --- | --- | ---: | --- |
| 1 | `FileExplorer.tsx` (73.5 kB source) | Static Inspector import; Files tab is common but not first paint. | ~11 kB |
| 2 | `CommandPalette` | Overlay; next after Settings / SSH. | ~5 kB |

Do **not** lazy xterm. It is already its own chunk and is required for the first terminal.

## Benchmark hooks

Mounted from `useAppServices()` (called by `App.tsx`) only when `import.meta.env.VITE_TUNARA_BENCHMARK` is set. A normal production build replaces that env with `undefined`, so the single `import("./benchmarks")` is DCE’d and none of the six hooks land in `App-*.js`.

| Hook | Activate when |
| --- | --- |
| `useTerminalBenchmark` | `VITE_TUNARA_BENCHMARK=m0` or `m1-output` |
| `useM2SafeWriteBenchmark` | `m2-safe-write` |
| `useM2LocalSafeWriteBenchmark` | `m2-local-safe-write` |
| `useM2NativeCloseBenchmark` | `m2-native-close` |
| `usePhase3RestartBenchmark` | `phase3-restart` |
| `usePhase3TunnelBenchmark` | `phase3-tunnel` |

`src/modules/terminal/lib/terminal-benchmark.ts` still reads `import.meta.env.VITE_TUNARA_BENCHMARK` at module scope because `TerminalView` / `pty-bridge` / `useTerminalWebgl` import the mode flags. Unset → `TERMINAL_BENCHMARK_VARIANT === null` → `TERMINAL_BENCHMARK_MODE === false`. There is **no** `import.meta.env.DEV` gate. Runners are `scripts/benchmark-*.sh`, which set the env and run a **production** `tauri build`.

Production `pnpm build` (no env): after the gate, `rg -l "Benchmark" dist/assets` returns nothing. Distinctive strings (`benchmark:m0`, `m0-mounted-terminals`, …) are absent from `dist/`. `plugin-log` is only imported by the hooks and is out of the shipped JS.

A follow-up can split `TERMINAL_BENCHMARK_MODE` into a tiny module so `terminal-benchmark.ts` probe/register code is also out of the default graph. Rust benchmark modules are gated behind a cargo feature in a separate thread.

## CI

`.github/workflows/ci.yml` runs `pnpm build` then the budget file without a second Vite pass:

```yaml
      - name: Build frontend
        run: pnpm build

      - name: Check frontend bundle budget
        run: node --experimental-strip-types --test tests/bundle-budget.test.mjs
```

Using `pnpm test:bundle` here would rebuild. Keep the budget file off the default `pnpm test` chain so local `test:node` without `dist/` stays a skip, not a 3s Vite build.
