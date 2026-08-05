export type TerminalInputOwner = "tui" | "tunara";
export type TerminalInputEventKind =
  | "mouse-down" | "mouse-up" | "contextmenu" | "drag" | "wheel" | "double-click" | "link";
export type TerminalMouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any" | (string & {});
export type TerminalHostModifier = "shift" | "meta" | "alt";
export type TerminalPlatform = "macos" | "windows" | "linux" | "unknown";

export interface TerminalInputModifiers { shift: boolean; meta: boolean; alt: boolean; ctrl?: boolean }
export interface TerminalInputRoute {
  kind: TerminalInputEventKind;
  mouseTrackingMode: TerminalMouseTrackingMode;
  selection: boolean;
  pure: boolean;
  platform: TerminalPlatform;
  hostModifier: TerminalHostModifier;
  modifiers: TerminalInputModifiers;
  button?: number;
  explicitHostAction?: boolean;
}

export function defaultTerminalHostModifier(platform: TerminalPlatform): TerminalHostModifier {
  return platform === "macos" ? "meta" : "shift";
}

function hostRequested(input: TerminalInputRoute): boolean {
  return !!input.explicitHostAction || input.modifiers[input.hostModifier];
}

/** Process-independent ownership policy with a latch for the complete right-click gesture. */
export class TerminalInputRouter {
  private rightGesture: { owner: TerminalInputOwner; sawMouseUp: boolean; sawContextMenu: boolean } | null = null;

  route(input: TerminalInputRoute): TerminalInputOwner {
    const reporting = input.mouseTrackingMode !== "none";
    if (input.kind === "mouse-down" && input.button === 2) {
      const owner = hostRequested(input) || !reporting ? "tunara" : "tui";
      this.rightGesture = { owner, sawMouseUp: false, sawContextMenu: false };
      return owner;
    }
    if ((input.kind === "mouse-up" && input.button === 2) || input.kind === "contextmenu") {
      const owner = this.rightGesture?.owner ?? (hostRequested(input) || !reporting ? "tunara" : "tui");
      if (this.rightGesture) {
        if (input.kind === "contextmenu") this.rightGesture.sawContextMenu = true;
        else this.rightGesture.sawMouseUp = true;
        if (this.rightGesture.sawContextMenu && this.rightGesture.sawMouseUp) this.rightGesture = null;
      }
      return owner;
    }
    if (hostRequested(input)) return "tunara";
    return reporting ? "tui" : "tunara";
  }
}

export function routeTerminalInput(input: TerminalInputRoute): TerminalInputOwner {
  return new TerminalInputRouter().route(input);
}

interface TerminalLinkInputOwnershipOptions {
  getMouseTrackingMode: () => TerminalMouseTrackingMode;
  hasSelection: () => boolean;
  isPure: () => boolean;
  getPlatform: () => TerminalPlatform;
  getHostModifier: () => TerminalHostModifier;
}

/** Keeps link activation and xterm's pointer stream on one owner for the full click. */
export function createTerminalLinkInputOwnership(options: TerminalLinkInputOwnershipOptions) {
  let gestureOwner: TerminalInputOwner | null = null;
  const inputFor = (event: MouseEvent): TerminalInputRoute => ({
    kind: "link",
    mouseTrackingMode: options.getMouseTrackingMode(),
    selection: options.hasSelection(),
    pure: options.isPure(),
    platform: options.getPlatform(),
    hostModifier: options.getHostModifier(),
    modifiers: { shift: event.shiftKey, meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey },
    button: event.button,
  });
  const ownerFor = (event: MouseEvent) => routeTerminalInput(inputFor(event));
  const shouldActivate = (event: MouseEvent) => (gestureOwner ?? ownerFor(event)) === "tunara";
  const hostModified = (event: MouseEvent) => hostRequested(inputFor(event));
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    gestureOwner = ownerFor(event);
    if (gestureOwner === "tunara" && hostModified(event)) event.stopPropagation();
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (gestureOwner === "tunara" && hostModified(event)) event.stopPropagation();
    globalThis.setTimeout(() => { gestureOwner = null; }, 0);
  };
  return {
    shouldActivate,
    attach(element: HTMLElement): () => void {
      element.addEventListener("mousedown", onMouseDown);
      element.addEventListener("mouseup", onMouseUp);
      return () => {
        element.removeEventListener("mousedown", onMouseDown);
        element.removeEventListener("mouseup", onMouseUp);
      };
    },
  };
}
