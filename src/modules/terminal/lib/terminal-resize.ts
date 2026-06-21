import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

interface ObserveTerminalResizeOptions {
  element: HTMLElement;
  terminal: Terminal;
  fit: FitAddon;
  resizePty: (cols: number, rows: number) => void;
  isDisposed: () => boolean;
}

export function observeTerminalResize({
  element,
  terminal,
  fit,
  resizePty,
  isDisposed,
}: ObserveTerminalResizeOptions): () => void {
  let lastW = element.clientWidth;
  let lastH = element.clientHeight;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new ResizeObserver(() => {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      if (isDisposed()) return;
      const w = element.clientWidth;
      const h = element.clientHeight;
      if (w === lastW && h === lastH) return;
      if (w === 0 || h === 0) return;
      lastW = w;
      lastH = h;
      fit.fit();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (!isDisposed()) resizePty(terminal.cols, terminal.rows);
      }, 250);
    }, 8);
  });

  observer.observe(element);

  return () => {
    observer.disconnect();
    if (fitTimer) clearTimeout(fitTimer);
    if (resizeTimer) clearTimeout(resizeTimer);
  };
}
