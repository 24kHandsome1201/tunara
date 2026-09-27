/**
 * Pure renderer-selection logic for the terminal. No DOM, xterm or Tauri
 * imports so `tests/terminal-renderer-policy.test.mjs` can load it in Node.
 *
 * The runtime half (`terminal-glyph-self-check.ts`) renders a probe string in
 * a hidden terminal with the WebGL addon, reads the drawn pixels back and
 * hands the per-cell observations to `analyzeGlyphProbe` (in
 * `terminal-glyph-probe.ts`); `useTerminalWebgl` then feeds the verdict into
 * `decideTerminalRenderer`.
 */

export type TerminalRendererPreference = "auto" | "gpu" | "compat";
export const TERMINAL_RENDERER_PREFERENCES: readonly TerminalRendererPreference[] = ["auto", "gpu", "compat"];
export const DEFAULT_TERMINAL_RENDERER: TerminalRendererPreference = "auto";

export function isTerminalRendererPreference(value: unknown): value is TerminalRendererPreference {
  return value === "auto" || value === "gpu" || value === "compat";
}

export function sanitizeTerminalRendererPreference(value: unknown): TerminalRendererPreference {
  return isTerminalRendererPreference(value) ? value : DEFAULT_TERMINAL_RENDERER;
}

export type TerminalRendererKind = "webgl" | "dom";
export type GlyphSelfCheckStatus = "pending" | "passed" | "failed" | "unavailable";

/** Why the GPU renderer was declared unsafe for the rest of the process. */
export type GpuFault = "context-lost" | "init-failed";

export interface RendererDecisionInput {
  preference: TerminalRendererPreference;
  selfCheck: GlyphSelfCheckStatus;
  /** Set once WebGL failed at runtime while `auto` was in charge. */
  gpuFault: GpuFault | null;
}

/**
 * `compat` always renders with DOM. `gpu` forces WebGL whenever the addon can
 * be created, keeping the existing per-terminal fallback for context loss and
 * init failures. `auto` only enables WebGL after the glyph self-check passed
 * and no WebGL fault has been recorded since; any of those signals pins the
 * process to DOM so panes never flap between renderers.
 */
export function decideTerminalRenderer(input: RendererDecisionInput): TerminalRendererKind {
  if (input.preference === "compat") return "dom";
  if (input.preference === "gpu") return "webgl";
  if (input.gpuFault) return "dom";
  return input.selfCheck === "passed" ? "webgl" : "dom";
}

/** `auto` needs a verdict before it can pick WebGL; the other modes never probe. */
export function shouldRunGlyphSelfCheck(input: RendererDecisionInput): boolean {
  return input.preference === "auto" && input.selfCheck === "pending" && input.gpuFault === null;
}

/** Cache key for a self-check verdict; any of these changes invalidates the glyph atlas assumptions. */
export function glyphSelfCheckKey(fontFamily: string, fontSize: number, devicePixelRatio: number): string {
  return `${fontFamily}|${fontSize}|${devicePixelRatio}`;
}
