import { useEffect, useSyncExternalStore, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { fallbackTerminalContextIfCurrent, fallbackTerminalToDom } from "@/modules/terminal/lib/terminal-webgl-fallback";
import { registerTerminalBenchmarkRendererControl, TERMINAL_BENCHMARK_MODE, TERMINAL_BENCHMARK_RENDERER_OVERRIDE } from "@/modules/terminal/lib/terminal-benchmark";
import { buildTerminalFontFamily } from "@/modules/terminal/lib/terminal-font";
import { useUIStore } from "@/state/ui";
import {
  decideTerminalRenderer,
  glyphSelfCheckKey,
  shouldRunGlyphSelfCheck,
  type GlyphSelfCheckStatus,
  type GpuFault,
  type TerminalRendererPreference,
} from "@/modules/terminal/lib/terminal-renderer-policy";
import type { GlyphSelfCheckReport } from "@/modules/terminal/lib/terminal-glyph-self-check";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";

export type TerminalWebglRenderer = WebglAddon;

// addon-webgl 0.19 can corrupt glyph UVs/texture bindings when atlas pages
// merge (xterm.js #5883, #6042, #6055). WebGL is therefore opt-in per
// process: `auto` only enables it after the runtime glyph self-check draws
// the mixed-width probe correctly, and any context loss under `auto` pins the
// process back to DOM. Existing mitigations (per-pane atlas isolation, atlas
// rebuilds on output pressure/focus/theme changes) stay active under WebGL.
const MAX_WEBGL_CONTEXTS = 8;

export interface TerminalRendererPolicy {
  preference: TerminalRendererPreference;
  /** Fully resolved CSS font family the live terminals render with. */
  fontFamily: string;
  fontSize: number;
}

interface ContextEntry {
  addon: WebglAddon;
  term: Terminal;
  transparent: boolean;
  rendererRef: RefObject<TerminalWebglRenderer | null>;
}

const contextMap = new Map<string, ContextEntry>();
const lruOrder: string[] = [];

export interface TerminalGpuHealth {
  selfCheck: GlyphSelfCheckStatus;
  selfCheckKey: string | null;
  report: GlyphSelfCheckReport | null;
  gpuFault: GpuFault | null;
}

let gpuHealth: TerminalGpuHealth = { selfCheck: "pending", selfCheckKey: null, report: null, gpuFault: null };
let pendingSelfCheck: Promise<void> | null = null;
// The addon (~20 kB gzip) stays out of the first-load bundle: it is only
// fetched once a pane is actually allowed to render with WebGL.
let webglAddonModule: Promise<typeof import("@xterm/addon-webgl")> | null = null;

function loadWebglAddon(): Promise<typeof WebglAddon> {
  webglAddonModule ??= import("@xterm/addon-webgl");
  return webglAddonModule.then((mod) => mod.WebglAddon);
}
const gpuHealthListeners = new Set<() => void>();

function setGpuHealth(next: Partial<TerminalGpuHealth>) {
  gpuHealth = { ...gpuHealth, ...next };
  for (const listener of gpuHealthListeners) listener();
}

function subscribeGpuHealth(listener: () => void): () => void {
  gpuHealthListeners.add(listener);
  return () => { gpuHealthListeners.delete(listener); };
}

export function getTerminalGpuHealth(): TerminalGpuHealth {
  return gpuHealth;
}

export function useTerminalGpuHealth(): TerminalGpuHealth {
  return useSyncExternalStore(subscribeGpuHealth, getTerminalGpuHealth, getTerminalGpuHealth);
}

/** Test/benchmark hook: forget the cached self-check verdict and context-loss flag. */
export function resetTerminalGpuHealth(): void {
  pendingSelfCheck = null;
  setGpuHealth({ selfCheck: "pending", selfCheckKey: null, report: null, gpuFault: null });
}

function selfCheckStatusFor(key: string): GlyphSelfCheckStatus {
  return gpuHealth.selfCheckKey === key ? gpuHealth.selfCheck : "pending";
}

function ensureGlyphSelfCheck(key: string, policy: TerminalRendererPolicy): void {
  if (pendingSelfCheck && gpuHealth.selfCheckKey === key) return;
  setGpuHealth({ selfCheck: "pending", selfCheckKey: key, report: null });
  const run = import("@/modules/terminal/lib/terminal-glyph-self-check")
    .then(({ runGlyphSelfCheck }) => runGlyphSelfCheck({ fontFamily: policy.fontFamily, fontSize: policy.fontSize }))
    .then((report) => {
      if (pendingSelfCheck !== run) return;
      pendingSelfCheck = null;
      console.debug("[useTerminalWebgl] glyph self-check", report.status, report.reason ?? "", report);
      setGpuHealth({ selfCheck: report.status, report });
    }, (error) => {
      if (pendingSelfCheck !== run) return;
      pendingSelfCheck = null;
      console.debug("[useTerminalWebgl] glyph self-check crashed", error);
      setGpuHealth({ selfCheck: "unavailable", report: null });
    });
  pendingSelfCheck = run;
}

function loseWebglContext(addon: WebglAddon | null, term: Terminal | null) {
  if (!addon) return { triggered: false, method: "no-webgl-renderer" };
  const internal = addon as unknown as { _renderer?: { _gl?: WebGL2RenderingContext } };
  const internalGl = internal._renderer?._gl;
  const internalExtension = internalGl?.getExtension("WEBGL_lose_context");
  if (internalExtension) {
    internalExtension.loseContext();
    return { triggered: true, method: "renderer-webgl-lose-context" };
  }
  for (const canvas of term?.element?.querySelectorAll("canvas") ?? []) {
    try {
      const gl = canvas.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (extension) {
        extension.loseContext();
        return { triggered: true, method: "canvas-webgl-lose-context" };
      }
    } catch {
      // Other xterm canvases may already own a 2D context.
    }
  }
  return { triggered: false, method: "webgl-lose-context-unavailable" };
}

function touchLRU(id: string) {
  const idx = lruOrder.indexOf(id);
  if (idx >= 0) lruOrder.splice(idx, 1);
  lruOrder.unshift(id);
}

function forgetContext(id: string) {
  contextMap.delete(id);
  const idx = lruOrder.indexOf(id);
  if (idx >= 0) lruOrder.splice(idx, 1);
}

function evictIfNeeded() {
  while (lruOrder.length > MAX_WEBGL_CONTEXTS) {
    const evictId = lruOrder.pop();
    if (!evictId) break;
    const entry = contextMap.get(evictId);
    if (entry) {
      try { entry.addon.dispose(); } catch (e) { console.debug("[useTerminalWebgl] dispose on LRU eviction failed", e); }
      if (entry.rendererRef.current === entry.addon) entry.rendererRef.current = null;
      contextMap.delete(evictId);
    }
  }
}

function disposeEntry(sessionId: string, entry: ContextEntry, why: string) {
  try { entry.addon.dispose(); } catch (e) { console.debug(`[useTerminalWebgl] dispose ${why} failed`, e); }
  if (entry.rendererRef.current === entry.addon) entry.rendererRef.current = null;
  forgetContext(sessionId);
}

export function useTerminalWebgl(
  termRef: RefObject<Terminal | null>,
  active: boolean,
  webglRef: RefObject<TerminalWebglRenderer | null>,
  sessionId: string,
  // Flips true once the (async-created) terminal is assigned to termRef. The
  // other deps are stable refs, so without this the effect would bail on a null
  // term at first mount and never re-run — leaving a new session on the slow
  // DOM renderer until a tab switch. Used only to re-trigger; value unread.
  termReady: boolean,
  fitRef?: RefObject<FitAddon | null>,
  ptyRef?: RefObject<PtySession | null>,
  // Both default to the live Settings values; tests and benchmarks pin them.
  transparency?: boolean,
  policy?: TerminalRendererPolicy,
) {
  const health = useTerminalGpuHealth();
  const storePreference = useUIStore((s) => s.terminalRenderer);
  const storeFontFamily = useUIStore((s) => s.fontFamily);
  const storeFontSize = useUIStore((s) => s.fontSize);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const backgroundOpacity = useUIStore((s) => s.backgroundOpacity);
  const allowTransparency = transparency ?? backgroundOpacity < 1;
  const preference = policy?.preference ?? TERMINAL_BENCHMARK_RENDERER_OVERRIDE ?? storePreference;
  const fontFamily = policy?.fontFamily ?? buildTerminalFontFamily(storeFontFamily, nerdFontFallback);
  const fontSize = policy?.fontSize ?? storeFontSize;
  const selfCheckKey = glyphSelfCheckKey(fontFamily, fontSize, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const selfCheck = selfCheckStatusFor(selfCheckKey);
  const decision = decideTerminalRenderer({ preference, selfCheck, gpuFault: health.gpuFault });

  useEffect(() => {
    if (!TERMINAL_BENCHMARK_MODE) return;
    return registerTerminalBenchmarkRendererControl(sessionId, {
      mode: () => webglRef.current ? "webgl" : "dom",
      loseContext: () => loseWebglContext(webglRef.current, termRef.current),
    });
  }, [sessionId, termReady, termRef, webglRef]);

  useEffect(() => {
    if (!termRef.current) return;
    if (shouldRunGlyphSelfCheck({ preference, selfCheck, gpuFault: health.gpuFault })) {
      ensureGlyphSelfCheck(selfCheckKey, { preference, fontFamily, fontSize });
    }
  }, [fontFamily, fontSize, health.gpuFault, preference, selfCheck, selfCheckKey, termReady, termRef]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;

    const existing = contextMap.get(sessionId);
    if (decision === "dom") {
      // Preference flipped to compat, the self-check failed after a context
      // was reused, or a context was lost elsewhere: put this pane back on DOM.
      if (existing && existing.term === term) {
        fallbackTerminalToDom(existing.addon, term, () => {
          if (existing.rendererRef.current === existing.addon) existing.rendererRef.current = null;
          forgetContext(sessionId);
        });
      } else if (existing) {
        disposeEntry(sessionId, existing, "stale renderer");
      }
      if (webglRef.current) webglRef.current = null;
      return;
    }

    // Reuse existing context for this session (e.g. after tab switch back).
    if (existing && existing.term === term && existing.transparent === allowTransparency) {
      webglRef.current = existing.addon;
      if (active) touchLRU(sessionId);
      return;
    }
    if (existing) disposeEntry(sessionId, existing, "replaced renderer");
    // A transparency change invalidates cached renderers even for inactive
    // panes. Leave those panes on DOM until activation instead of keeping a
    // renderer whose alpha mode no longer matches terminal.options.
    if (!active) return;

    // Create a new WebGL context once the lazily loaded addon arrives; the
    // effect may have been superseded (pane closed, preference flipped) by then.
    const attachWebgl = (Addon: typeof WebglAddon) => {
      if (cancelled || termRef.current !== term || contextMap.has(sessionId)) return;
      const webgl = new Addon();
      webgl.onContextLoss(() => {
        if (preference === "auto") setGpuHealth({ gpuFault: "context-lost" });
        fallbackTerminalContextIfCurrent(webgl, term, () => {
          const current = contextMap.get(sessionId);
          return current?.addon === webgl && current.term === term;
        }, () => {
          forgetContext(sessionId);
          if (webglRef.current === webgl) webglRef.current = null;
        });
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      contextMap.set(sessionId, { addon: webgl, term, transparent: allowTransparency, rendererRef: webglRef });
      touchLRU(sessionId);
      evictIfNeeded();
      // WebGL replaces the renderer and changes cell metrics. The init path
      // fitted against the DOM renderer and opened the PTY with those cols/
      // rows; without a refit, Codex/Grok TUIs wrap against a stale grid
      // until the user resizes the window. Container size is unchanged, so
      // ResizeObserver will not fire.
      try {
        fitRef?.current?.fit();
        ptyRef?.current?.resize(term.cols, term.rows)?.catch(() => {});
      } catch {
        /* fit/resize can race pane teardown */
      }
    };
    loadWebglAddon().then(attachWebgl).catch((e) => {
      if (cancelled) return;
      console.debug("[useTerminalWebgl] WebGL addon init failed, falling back to DOM renderer", e);
      webglRef.current = null;
      if (preference === "auto") setGpuHealth({ gpuFault: "init-failed" });
    });
    return () => { cancelled = true; };
  }, [active, allowTransparency, decision, preference, sessionId, termRef, webglRef, termReady, fitRef, ptyRef]);

  // Release on unmount. Inactive terminals keep their context for fast
  // tab-switching; LRU eviction handles the cap.
  useEffect(() => {
    return () => {
      const entry = contextMap.get(sessionId);
      if (entry) disposeEntry(sessionId, entry, "on unmount");
    };
  }, [sessionId]);
}
