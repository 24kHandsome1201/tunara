# Frontend performance budget

README promises an installer of about **30 MB** and that the app **opens nearly instantly**. This document is the frontend half of that promise: a measured Vite production bundle, a gzip budget with a 10% growth cap, and the lazy-load / benchmark-hook work that still belongs to other threads.

This orb cannot produce a macOS `.app` / `.dmg`, so **installer size and real cold-start latency are not verified here**. The guardrail is the webview JS (and CSS, for context) that Tauri loads.

## How to run

```bash
pnpm test:bundle
```

That is `pnpm build && node --experimental-strip-types --test tests/bundle-budget.test.mjs`.

`pnpm test` / `pnpm test:node` do **not** rebuild. If `dist/` is missing, the budget file skips and tells you to build first; if `dist/` is present (CI already runs `pnpm build` before Node tests), the same assertions run against that tree.

Gzip in the test matches Vite's reporter: `promisify(gzip)` from `node:zlib`.

## Baseline

Measured **2026-09-02** on `origin/main` @ `833c48919e4edd1fc89e040e55ed19a5a0c9807f`, `pnpm build`, Vite 7.3.6, 325 modules. `vite.config.ts` was **not** changed for this measurement (`manualChunks` already splits `react` and `xterm`).

`src/main.tsx` is a boot stub: it loads fonts/CSS, then `import("./app/App")`. `index.html` modulepreloads `react-*.js` and `xterm-*.js`. Async chunks (`FilePreview`, `TransferCenter`, `ForwardingPanel`) are **not** preloaded.

### JS chunks

| Chunk | Raw | Gzip | On first load? | Main sources |
| --- | ---: | ---: | --- | --- |
| `main-*.js` | 2.99 kB | 1.55 kB | yes (HTML entry) | `src/main.tsx` |
| `App-*.js` | 707.58 kB | 198.76 kB | yes (dynamic import from boot) | app shell, terminals, overlays, i18n, Tauri plugins, Zustand |
| `react-*.js` | 192.51 kB | 60.35 kB | yes (modulepreload + `manualChunks`) | `react`, `react-dom`, `scheduler` |
| `xterm-*.js` | 545.23 kB | 145.44 kB | yes (modulepreload + `manualChunks`) | `@xterm/xterm` + every addon |
| `FilePreview-*.js` | 56.27 kB | 16.94 kB | **lazy** | `FilePreview.tsx`, markdown/notebook/tabular preview |
| `ForwardingPanel-*.js` | 10.06 kB | 2.90 kB | **lazy** | `ForwardingPanel.tsx` |
| `TransferCenter-*.js` | 8.85 kB | 2.90 kB | **lazy** | `TransferCenter.tsx` |
| **Total JS** | **1 523.48 kB** | **428.82 kB** | | |

Vite reporter kB is `bytes / 1000`. Exact gzip bytes used by the test:

| Guard | Bytes | × 1.1 budget |
| --- | ---: | ---: |
| Entry = `App-*.js` | 198 755 | 218 630 |
| Total `dist/assets/*.js` | 428 818 | 471 699 |

The HTML entry (`main-*.js`, 1.55 kB gzip) is too small to be a useful cap. The budgeted **entry chunk** is the application bundle `App-*.js`.

Startup JS actually fetched before the shell paints (boot + modulepreload + App) is **406.09 kB gzip** (main + react + xterm + App). Lazy Inspector/preview chunks add the remaining ~23 kB gzip if those views open.

### CSS and fonts (not in the JS test)

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `main-*.css` | 113.89 kB | 39.46 kB |
| `xterm-*.css` | 3.60 kB | 0.99 kB |
| JetBrains Mono (latin/ext/cyrillic/greek/vietnamese, 400–700, woff + woff2) | ~400 kB files on disk | n/a (woff2 already compressed) |

### Feature → chunk map

| Surface | Chunk today | Code-split? |
| --- | --- | --- |
| xterm + fit / search / serialize / web-links / image / webgl | `xterm-*.js` | yes, but **modulepreloaded** on every launch |
| `FilePreview` + `markdown-reader` / `markdown-syntax` / `notebook` / `tabular-preview` | `FilePreview-*.js` | **yes** — `lazy()` in `MainArea.tsx` |
| `DiffPanel` | `App-*.js` | no — static import from `InspectorPanel.tsx` |
| `SshConnect` | `App-*.js` | no — static import from `App.tsx` |
| Settings overlay + `overlays/settings/*` | `App-*.js` | no — static import from `App.tsx` |
| `TransferCenter` | `TransferCenter-*.js` | **yes** — `lazy()` in `InspectorPanel.tsx` |
| `ForwardingPanel` | `ForwardingPanel-*.js` | **yes** — `lazy()` in `InspectorPanel.tsx` |

Both locale JSON files (`en.json` ~72 kB, `zh-CN.json` ~71 kB source) are inlined into `App-*.js`.

## Budget rule

- After a production `pnpm build`, `App-*.js` gzip ≤ **198 755 × 1.1**.
- Sum of gzip of every `dist/assets/*.js` ≤ **428 818 × 1.1**.
- Re-measure and update the constants in `tests/bundle-budget.test.mjs` (and the tables here) only when the growth is intentional. Record date + commit.

This does **not** replace a macOS installer budget. 30 MB is a Tauri/Rust/WebView packing claim; keep it on the release checklist.

## Lazy-load recommendations (do not implement here)

These files belong to other redesign threads. Estimates use FilePreview as a calibration: ~116 kB of source-map content became 16.94 kB gzip (~15% of source). Apply that ratio to overlay/Inspector modules that currently sit in `App-*.js`.

| Rank | Module | Why | Est. gzip out of `App-*.js` |
| --- | --- | ---: | --- |
| 1 | `SshConnect` (`src/ui/overlays/SshConnect.tsx`, 48.8 kB source) | Overlay; only after “new SSH”. Same `lazy()` pattern as FilePreview. | ~7 kB |
| 2 | Settings shell + `overlays/settings/*` (~63 kB source) | Overlay; `⌘,` / palette. Tabs can stay in one async chunk. | ~9 kB |
| 3 | `DiffPanel` (`src/ui/DiffPanel.tsx`, 32.9 kB source) | Inspector Changes only; `TransferCenter` / `ForwardingPanel` already lazy. | ~5 kB |

Together ~**21 kB gzip** (~11% of `App-*.js`). That helps parse/eval of the shell, not the xterm/react preload.

Larger than all three, but a product call: `FileExplorer.tsx` (73.5 kB source, ~11 kB gzip) is also a static Inspector import. `CommandPalette` (~5 kB gzip) is the next overlay candidate.

Do **not** lazy xterm. It is already its own chunk and is required for the first terminal.

## Benchmark hooks

Mounted from `useAppServices()` (called by `App.tsx`), not by a shortcut or URL:

| Hook | Activate when |
| --- | --- |
| `useTerminalBenchmark` | `VITE_TUNARA_BENCHMARK=m0` or `m1-output` |
| `useM2SafeWriteBenchmark` | `m2-safe-write` |
| `useM2LocalSafeWriteBenchmark` | `m2-local-safe-write` |
| `useM2NativeCloseBenchmark` | `m2-native-close` |
| `usePhase3RestartBenchmark` | `phase3-restart` |
| `usePhase3TunnelBenchmark` | `phase3-tunnel` |

`src/modules/terminal/lib/terminal-benchmark.ts` reads `import.meta.env.VITE_TUNARA_BENCHMARK` at module scope. Unset → `TERMINAL_BENCHMARK_VARIANT === null` → `TERMINAL_BENCHMARK_MODE === false`. There is **no** `import.meta.env.DEV` gate. Runners are `scripts/benchmark-*.sh`, which set the env and run a **production** `tauri build`.

Production `pnpm build` (no env): Vite still **parses** all six hooks (see the `@tauri-apps/plugin-log` dynamic/static import warning). Distinctive strings (`benchmark:m0`, `m0-mounted-terminals`, …) are **absent** from `dist/` — branch DCE kills the bodies. Source maps of a `--sourcemap` build still list the hook files inside `App-*.js`, so the modules remain in the graph. `plugin-log` is only imported by these hooks and is DCE’d out of the shipped JS. `terminal-benchmark.ts` stays because `TerminalView` / `pty-bridge` / `useTerminalWebgl` import it; with `MODE === false` the register paths are no-ops.

### Recommendation

Prefer **(a) compile-time env + dynamic import**, not DEV-only and not delete.

- **Do not use `import.meta.env.DEV`.** Benchmark bundles are production builds with `VITE_TUNARA_BENCHMARK` set; a DEV gate would disable the harness.
- **Do not delete.** `scripts/benchmark-*.sh` and `tests/m2-safe-write-benchmark-gate.test.mjs` depend on the hooks.
- **(b) moving to `scripts/`** cannot work as-is: the hooks click real DOM and call session stores inside the webview.

`App.tsx` is owned by another thread. Apply the gate in `useAppServices.ts` so a normal production build drops the dynamic import entirely (Vite replaces `import.meta.env.VITE_TUNARA_BENCHMARK` with `undefined`):

```ts
// src/app/useAppServices.ts
import { useEffect } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useDockBadge } from "./useDockBadge";
import { useGlobalShortcut } from "./useGlobalShortcut";
import { useInit } from "./useInit";
import { useKeybindings } from "./useKeybindings";
import { usePresentationModeContextMenuGuard } from "./usePresentationModeContextMenuGuard";
import { useTheme } from "./useTheme";
import { useUpdateReminder } from "./useUpdateReminder";

function useNoopBenchmark(_ready: boolean): void {}

const useTerminalBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./useTerminalBenchmark")).useTerminalBenchmark
  : useNoopBenchmark;
const usePhase3RestartBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./usePhase3RestartBenchmark")).usePhase3RestartBenchmark
  : useNoopBenchmark;
const usePhase3TunnelBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./usePhase3TunnelBenchmark")).usePhase3TunnelBenchmark
  : useNoopBenchmark;
const useM2SafeWriteBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./useM2SafeWriteBenchmark")).useM2SafeWriteBenchmark
  : useNoopBenchmark;
const useM2LocalSafeWriteBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./useM2LocalSafeWriteBenchmark")).useM2LocalSafeWriteBenchmark
  : useNoopBenchmark;
const useM2NativeCloseBenchmark = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./useM2NativeCloseBenchmark")).useM2NativeCloseBenchmark
  : useNoopBenchmark;

/** Mounts app-wide lifecycle services once, outside the shell layout markup. */
export function useAppServices(ready: boolean, purePresentation: boolean): void {
  useInit();
  useTheme();
  useKeybindings();
  useDockBadge();
  useGlobalShortcut();
  useUpdateReminder(ready);

  useTerminalBenchmark(ready);
  usePhase3RestartBenchmark(ready);
  usePhase3TunnelBenchmark(ready);
  useM2SafeWriteBenchmark(ready);
  useM2LocalSafeWriteBenchmark(ready);
  useM2NativeCloseBenchmark(ready);

  usePresentationModeContextMenuGuard(purePresentation);

  useEffect(() => {
    void useTransferStore.getState().loadJournal();
  }, []);
}
```

A follow-up can split `TERMINAL_BENCHMARK_MODE` into a tiny module so `terminal-benchmark.ts` probe/register code is also out of the default graph.

## CI

`.github/workflows/ci.yml` already runs `pnpm build` before Node tests. Suggested addition (do not apply from this thread): after that build, run the budget file **without** a second `pnpm build`:

```diff
       - name: Build frontend
         run: pnpm build
+
+      - name: Check frontend bundle budget
+        run: node --experimental-strip-types --test tests/bundle-budget.test.mjs

       - name: Check Rust formatting
```

Using `pnpm test:bundle` here would rebuild. The Node step above reuses `dist/` from the previous step. Keep it off the default `pnpm test` chain so local `test:node` without `dist/` stays a skip, not a 3s Vite build.
