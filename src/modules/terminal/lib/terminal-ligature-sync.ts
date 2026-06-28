import type { Terminal } from "@xterm/xterm";
import { useUIStore } from "@/state/ui";
import { registerTerminalLigatures, type TerminalLigatureRegistration } from "./terminal-ligatures";

export function registerTerminalLigatureSync(
  term: Terminal,
  // Toggling ligatures changes glyph shaping, so the WebGL renderer's baked
  // texture atlas is now stale. term.refresh() only repaints dirty rows under
  // WebGL — it does not rebuild the atlas — so callers pass this to force a
  // rebuild. No-op under the DOM renderer.
  rebuildAtlas?: () => void,
): () => void {
  let ligatures: TerminalLigatureRegistration | null = null;
  const sync = (enabled: boolean) => {
    ligatures?.dispose();
    ligatures = enabled ? registerTerminalLigatures(term) : null;
    term.refresh(0, term.rows - 1);
    rebuildAtlas?.();
  };
  sync(useUIStore.getState().fontLigatures);
  const unsubscribe = useUIStore.subscribe((s) => s.fontLigatures, sync);
  return () => {
    unsubscribe();
    ligatures?.dispose();
  };
}
