import type { Terminal } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";

// A conservative memory ceiling for decoded inline images. The addon's default
// is ~128 MB, which would blow Tunara's ~30 MB lightweight footprint out of the
// water; 24 MB is plenty for "glance at a plot / icat preview" without letting a
// chatty SIXEL stream balloon memory. The FIFO cache evicts oldest-first.
const IMAGE_STORAGE_LIMIT_MB = 24;

/**
 * Enable inline image output (SIXEL + iTerm IIP) on a terminal. Load AFTER the
 * WebGL renderer so the addon picks up the active renderer. Returns a disposer.
 *
 * Pairs well with the SSH/SFTP panel: `icat`/matplotlib output on a remote host
 * can be glanced at in the stream without scp'ing it back. Images are not part
 * of the text serialize() snapshot, so they're lost on restore — same semantics
 * as the existing "restored snapshot" notice, and acceptable for a preview.
 */
export function registerTerminalImage(term: Terminal): () => void {
  const addon = new ImageAddon({
    storageLimit: IMAGE_STORAGE_LIMIT_MB,
    // SIXEL + iTerm IIP only; the kitty graphics protocol is deliberately not
    // pursued (heavier, still maturing, and off our lightweight target).
    enableSizeReports: true,
  });
  term.loadAddon(addon);
  return () => addon.dispose();
}
