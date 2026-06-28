import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export type TerminalWebglRenderer = WebglAddon;

const MAX_WEBGL_CONTEXTS = 8;

interface ContextEntry {
  addon: WebglAddon;
  term: Terminal;
}

const contextMap = new Map<string, ContextEntry>();
const lruOrder: string[] = [];

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
) {
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!active) return;

    // Reuse existing context for this session (e.g. after tab switch back).
    const existing = contextMap.get(sessionId);
    if (existing && existing.term === term) {
      webglRef.current = existing.addon;
      touchLRU(sessionId);
      return;
    }

    // Create a new WebGL context.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        contextMap.delete(sessionId);
        const idx = lruOrder.indexOf(sessionId);
        if (idx >= 0) lruOrder.splice(idx, 1);
        if (webglRef.current === webgl) webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
      contextMap.set(sessionId, { addon: webgl, term });
      touchLRU(sessionId);
      evictIfNeeded();
    } catch (e) {
      console.debug("[useTerminalWebgl] WebGL addon init failed, falling back to DOM renderer", e);
      webglRef.current = null;
    }
  }, [active, sessionId, termRef, webglRef, termReady]);

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
