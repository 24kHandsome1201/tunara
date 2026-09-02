import { useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";

const CHROME_SELECTOR = ".tunara-titlebar, .tunara-sidebar, .tunara-panel";

function isInsideChrome(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(CHROME_SELECTOR);
}

function isTerminalFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof Element)) return false;
  return !!active.closest(".xterm, [data-terminal-canvas]");
}

function overlayBlocksFade(overlay: string | null, hostKeyOpen: boolean, keyboardInteractiveOpen: boolean): boolean {
  return overlay !== null || hostKeyOpen || keyboardInteractiveOpen;
}

/**
 * Fade workspace chrome while the terminal holds keyboard focus and no
 * overlay/dialog is open. Hovering chrome or leaving the terminal restores
 * full opacity immediately.
 */
export function useChromeFade(): boolean {
  const overlay = useUIStore((s) => s.overlay);
  const hostKeyOpen = useUIStore((s) => s.hostKeyPrompts.length > 0);
  const keyboardInteractiveOpen = useUIStore((s) => s.keyboardInteractivePrompts.length > 0);
  const [terminalFocused, setTerminalFocused] = useState(false);
  const [hoveringChrome, setHoveringChrome] = useState(false);

  useEffect(() => {
    const syncFocus = () => setTerminalFocused(isTerminalFocused());
    const onPointerOver = (event: PointerEvent) => {
      if (isInsideChrome(event.target)) setHoveringChrome(true);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!isInsideChrome(event.relatedTarget)) setHoveringChrome(false);
    };

    syncFocus();
    document.addEventListener("focusin", syncFocus);
    document.addEventListener("focusout", syncFocus);
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    return () => {
      document.removeEventListener("focusin", syncFocus);
      document.removeEventListener("focusout", syncFocus);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
    };
  }, []);

  return terminalFocused
    && !hoveringChrome
    && !overlayBlocksFade(overlay, hostKeyOpen, keyboardInteractiveOpen);
}
