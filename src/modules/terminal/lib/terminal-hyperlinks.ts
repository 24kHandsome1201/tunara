import type { ILinkHandler } from "@xterm/xterm";

export function normalizeTerminalHyperlink(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createTerminalHyperlinkHandler(
  openUrl: (url: string) => Promise<unknown> | unknown,
  shouldActivate: (event: MouseEvent) => boolean = () => true,
): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate(event, text) {
      if (!shouldActivate(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const url = normalizeTerminalHyperlink(text);
      if (!url) return;
      Promise.resolve(openUrl(url)).catch(() => {});
    },
  };
}
