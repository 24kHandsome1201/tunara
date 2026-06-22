import type { Terminal } from "@xterm/xterm";
import { useUIStore } from "@/state/ui";
import { registerTerminalLigatures, type TerminalLigatureRegistration } from "./terminal-ligatures";

export function registerTerminalLigatureSync(term: Terminal): () => void {
  let ligatures: TerminalLigatureRegistration | null = null;
  const sync = (enabled: boolean) => {
    ligatures?.dispose();
    ligatures = enabled ? registerTerminalLigatures(term) : null;
    term.refresh(0, term.rows - 1);
  };
  sync(useUIStore.getState().fontLigatures);
  const unsubscribe = useUIStore.subscribe((s) => s.fontLigatures, sync);
  return () => {
    unsubscribe();
    ligatures?.dispose();
  };
}
