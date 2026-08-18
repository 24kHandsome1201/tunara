import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { fallbackTerminalContextIfCurrent } from "@/modules/terminal/lib/terminal-webgl-fallback";
import { registerTerminalBenchmarkRendererControl, TERMINAL_BENCHMARK_MODE } from "@/modules/terminal/lib/terminal-benchmark";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";

export type TerminalWebglRenderer = WebglAddon;

const MAX_WEBGL_CONTEXTS = 8;

interface ContextEntry {
  addon: WebglAddon;
  term: Terminal;
  transparent: boolean;
}

const contextMap = new Map<string, ContextEntry>();
const lruOrder: string[] = [];

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

function evictIfNeeded() {
  while (lruOrder.length > MAX_WEBGL_CONTEXTS) {
    const evictId = lruOrder.pop();
    if (!evictId) break;
    const entry = contextMap.get(evictId);
    if (entry) {
      try { entry.addon.dispose(); } catch (e) { console.debug("[useTerminalWebgl] dispose on LRU eviction failed", e); }
      contextMap.delete(evictId);
    }
  }
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
  allowTransparency = false,
) {
  useEffect(() => {
    if (!TERMINAL_BENCHMARK_MODE) return;
    return registerTerminalBenchmarkRendererControl(sessionId, {
      mode: () => webglRef.current ? "webgl" : "dom",
      loseContext: () => loseWebglContext(webglRef.current, termRef.current),
    });
  }, [sessionId, termReady, termRef, webglRef]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!active) return;

    // Reuse existing context for this session (e.g. after tab switch back).
    const existing = contextMap.get(sessionId);
    if (existing && existing.term === term && (!allowTransparency || existing.transparent)) {
      webglRef.current = existing.addon;
      touchLRU(sessionId);
      return;
    }
    if (existing) {
      try { existing.addon.dispose(); } catch (e) { console.debug("[useTerminalWebgl] dispose replaced renderer failed", e); }
      contextMap.delete(sessionId);
      const index = lruOrder.indexOf(sessionId);
      if (index >= 0) lruOrder.splice(index, 1);
    }

    // Create a new WebGL context.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        fallbackTerminalContextIfCurrent(webgl, term, () => {
          const current = contextMap.get(sessionId);
          return current?.addon === webgl && current.term === term;
        }, () => {
          contextMap.delete(sessionId);
          const idx = lruOrder.indexOf(sessionId);
          if (idx >= 0) lruOrder.splice(idx, 1);
          if (webglRef.current === webgl) webglRef.current = null;
        });
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      contextMap.set(sessionId, { addon: webgl, term, transparent: allowTransparency });
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
    } catch (e) {
      console.debug("[useTerminalWebgl] WebGL addon init failed, falling back to DOM renderer", e);
      webglRef.current = null;
    }
  }, [active, allowTransparency, sessionId, termRef, webglRef, termReady, fitRef, ptyRef]);

  // Release on unmount. Inactive terminals keep their context for fast
  // tab-switching; LRU eviction handles the cap.
  useEffect(() => {
    return () => {
      const entry = contextMap.get(sessionId);
      if (entry) {
        try { entry.addon.dispose(); } catch (e) { console.debug("[useTerminalWebgl] dispose on unmount failed", e); }
        contextMap.delete(sessionId);
        const idx = lruOrder.indexOf(sessionId);
        if (idx >= 0) lruOrder.splice(idx, 1);
      }
    };
  }, [sessionId]);
}
