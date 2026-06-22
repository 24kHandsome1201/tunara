import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { createTerminalWebglRenderer } from "@/modules/terminal/lib/terminal-webgl";

export type TerminalWebglRenderer = ReturnType<typeof createTerminalWebglRenderer>;

export function useTerminalWebgl(
  termRef: RefObject<Terminal | null>,
  active: boolean,
  webglRef: RefObject<TerminalWebglRenderer | null>,
) {
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) {
      if (!webglRef.current) webglRef.current = createTerminalWebglRenderer(term);
    } else {
      webglRef.current?.dispose();
      webglRef.current = null;
    }
  }, [active, termRef, webglRef]);
}
