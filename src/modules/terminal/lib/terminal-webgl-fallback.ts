export interface DisposableWebglRenderer {
  dispose: () => void;
}

export interface RefreshableTerminal {
  rows: number;
  refresh: (start: number, end: number) => void;
}

/**
 * Disposing xterm's WebGL addon restores the built-in DOM renderer. Refresh
 * every visible row immediately so recovery never depends on a later resize.
 */
export function fallbackTerminalToDom(
  renderer: DisposableWebglRenderer,
  terminal: RefreshableTerminal,
  onDisposed: () => void,
): void {
  try {
    renderer.dispose();
  } catch {
    // Context loss can make addon teardown itself throw. Registry cleanup and
    // a DOM repaint are still required, and this callback must not escape into
    // xterm's renderer event loop.
  } finally {
    onDisposed();
  }
  try {
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  } catch {
    // The terminal may have unmounted during context loss. Renderer teardown
    // still completed, so there is no stale WebGL context left to retain.
  }
}

/** Ignore a stale addon's late loss event. Disposing it here would make xterm
 * install the DOM renderer over the newer WebGL renderer for this terminal. */
export function fallbackTerminalContextIfCurrent(
  renderer: DisposableWebglRenderer,
  terminal: RefreshableTerminal,
  isCurrent: () => boolean,
  removeCurrent: () => void,
): void {
  if (!isCurrent()) return;
  fallbackTerminalToDom(renderer, terminal, removeCurrent);
}
