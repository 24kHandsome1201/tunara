import type { Terminal } from "@xterm/xterm";

export type PrimaryDeviceAttributesParams = Array<number | number[]>;

export interface TerminalDeviceAttributesOptions {
  isOsc52ClipboardWriteAllowed: () => boolean;
  /** Forward DA responses straight to the PTY writer — never through xterm's
   *  input pipeline, which would re-fire onData and echo garbage after exit. */
  sendInput: (data: string) => void;
}

interface PrimaryDeviceAttributesHandlerOptions extends TerminalDeviceAttributesOptions {
  sendInput: (data: string) => void;
}

export function registerTerminalDeviceAttributesHandler(
  term: Terminal,
  options: TerminalDeviceAttributesOptions,
): () => void {
  const disposable = term.parser.registerCsiHandler({ final: "c" }, (params) => handlePrimaryDeviceAttributesQuery(params, {
    isOsc52ClipboardWriteAllowed: options.isOsc52ClipboardWriteAllowed,
    sendInput: options.sendInput,
  }));
  return () => disposable.dispose();
}

export function handlePrimaryDeviceAttributesQuery(
  params: PrimaryDeviceAttributesParams,
  options: PrimaryDeviceAttributesHandlerOptions,
): boolean {
  if (isPrimaryDeviceAttributesQuery(params)) {
    options.sendInput(buildPrimaryDeviceAttributesResponse(options.isOsc52ClipboardWriteAllowed()));
    return true;
  }
  return shouldConsumeUnsupportedPrimaryDeviceAttributesQuery(params);
}

export function buildPrimaryDeviceAttributesResponse(osc52ClipboardWrite: boolean): string {
  const attributes = osc52ClipboardWrite ? "1;2;52" : "1;2";
  return `\x1b[?${attributes}c`;
}

function isPrimaryDeviceAttributesQuery(params: PrimaryDeviceAttributesParams): boolean {
  return params.length === 0 || (params.length === 1 && params[0] === 0);
}

function shouldConsumeUnsupportedPrimaryDeviceAttributesQuery(params: PrimaryDeviceAttributesParams): boolean {
  return params.length === 1 && typeof params[0] === "number" && params[0] > 0;
}
