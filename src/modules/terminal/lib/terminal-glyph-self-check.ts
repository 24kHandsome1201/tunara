import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  analyzeGlyphProbe,
  buildGlyphProbeLayout,
  compareRendererMetrics,
  PROBE_BACKGROUND,
  sampleColumnInk,
  type GlyphProbeAnalysis,
  type RendererCellMetrics,
} from "./terminal-glyph-probe.ts";

/**
 * Runtime half of the WebGL glyph self-check. Renders the mixed-width probe
 * row (CJK, CJK punctuation, emoji, box drawing, accented Latin, ANSI true
 * colour) in a hidden one-off terminal, first with xterm's DOM renderer to
 * capture the reference cell metrics, then swaps in `WebglAddon` with
 * `preserveDrawingBuffer` so the drawn frame can be read back and compared
 * cell by cell against the layout. Loaded on demand from `useTerminalWebgl`
 * so the probe stays off the startup path.
 */

export interface GlyphSelfCheckOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight?: number;
  /** Frames to wait for WebGL to draw the probe before giving up. */
  maxRenderFrames?: number;
  container?: HTMLElement;
}

export interface GlyphSelfCheckReport {
  status: "passed" | "failed" | "unavailable";
  reason: string | null;
  durationMs: number;
  metrics: {
    dom: RendererCellMetrics;
    webgl: RendererCellMetrics;
    matched: boolean;
    widthDelta: number;
    heightDelta: number;
  } | null;
  glyphs: GlyphProbeAnalysis | null;
  framesWaited: number;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function writeAndSettle(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function domCellMetrics(term: Terminal): RendererCellMetrics | null {
  const rows = term.element?.querySelector<HTMLElement>(".xterm-rows");
  if (!rows || term.cols <= 0 || term.rows <= 0) return null;
  const rect = rows.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { cellWidth: rect.width / term.cols, cellHeight: rect.height / term.rows };
}

function findWebglCanvas(term: Terminal): { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext } | null {
  for (const canvas of term.element?.querySelectorAll("canvas") ?? []) {
    try {
      const gl = canvas.getContext("webgl2");
      if (gl) return { canvas, gl };
    } catch {
      // Canvases that already own a 2D context throw or return null.
    }
  }
  return null;
}

function readCanvasPixels(canvas: HTMLCanvasElement): Uint8ClampedArray | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, copy.width, copy.height).data;
}

function hasAnyInk(pixels: Uint8ClampedArray, stride = 4): boolean {
  for (let index = 0; index + 2 < pixels.length; index += stride * 7) {
    if (pixels[index] > 24 || pixels[index + 1] > 24 || pixels[index + 2] > 24) return true;
  }
  return false;
}

export async function runGlyphSelfCheck(options: GlyphSelfCheckOptions): Promise<GlyphSelfCheckReport> {
  const startedAt = performance.now();
  const layout = buildGlyphProbeLayout();
  const maxRenderFrames = options.maxRenderFrames ?? 30;
  const host = options.container ?? document.body;
  const finish = (partial: Omit<GlyphSelfCheckReport, "durationMs">): GlyphSelfCheckReport => ({
    ...partial,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  });

  if (typeof WebGL2RenderingContext === "undefined") {
    return finish({ status: "unavailable", reason: "webgl2-unsupported", metrics: null, glyphs: null, framesWaited: 0 });
  }

  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.dataset.terminalGlyphProbe = "true";
  // xterm pauses rendering for terminals that do not intersect the viewport,
  // so the probe must sit inside it; opacity hides it without affecting the
  // GL framebuffer that the check reads back.
  Object.assign(container.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1200px",
    height: "160px",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  host.appendChild(container);

  let term: Terminal | null = null;
  let webgl: WebglAddon | null = null;
  let contextLost = false;
  try {
    term = new Terminal({
      cols: layout.columns + 1,
      rows: 2,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      lineHeight: options.lineHeight ?? 1.05,
      theme: { background: "#000000", foreground: "#ffffff", cursor: "#000000", cursorAccent: "#000000", selectionBackground: "#000000" },
      minimumContrastRatio: 1,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      disableStdin: true,
      scrollback: 0,
      allowProposedApi: true,
    });
    term.open(container);
    await writeAndSettle(term, `\u001b[?25l${layout.text}`);
    await nextFrame();
    const dom = domCellMetrics(term);
    if (!dom) {
      return finish({ status: "unavailable", reason: "dom-metrics-unavailable", metrics: null, glyphs: null, framesWaited: 0 });
    }

    try {
      webgl = new WebglAddon(true);
      webgl.onContextLoss(() => { contextLost = true; });
      term.loadAddon(webgl);
    } catch (error) {
      return finish({ status: "unavailable", reason: `webgl-init-failed: ${error instanceof Error ? error.message : String(error)}`, metrics: null, glyphs: null, framesWaited: 0 });
    }

    const target = findWebglCanvas(term);
    if (!target) {
      return finish({ status: "failed", reason: "webgl-canvas-missing", metrics: null, glyphs: null, framesWaited: 0 });
    }
    const dpr = window.devicePixelRatio || 1;
    let framesWaited = 0;
    let pixels: Uint8ClampedArray | null = null;
    while (framesWaited < maxRenderFrames) {
      await nextFrame();
      framesWaited += 1;
      if (contextLost) return finish({ status: "failed", reason: "webgl-context-lost", metrics: null, glyphs: null, framesWaited });
      pixels = readCanvasPixels(target.canvas);
      if (pixels && hasAnyInk(pixels)) break;
    }
    if (!pixels) {
      return finish({ status: "failed", reason: "webgl-pixels-unreadable", metrics: null, glyphs: null, framesWaited });
    }

    const webglMetrics: RendererCellMetrics = {
      cellWidth: target.canvas.width / dpr / term.cols,
      cellHeight: target.canvas.height / dpr / term.rows,
    };
    const comparison = compareRendererMetrics(dom, webglMetrics);
    const deviceCellWidth = target.canvas.width / term.cols;
    const deviceCellHeight = target.canvas.height / term.rows;
    const columns = sampleColumnInk(
      pixels,
      target.canvas.width,
      deviceCellWidth,
      deviceCellHeight,
      layout.columns,
      0,
      PROBE_BACKGROUND,
    );
    const glyphs = analyzeGlyphProbe(layout, columns);
    const metrics = { dom, webgl: webglMetrics, ...comparison };
    if (!comparison.matched) {
      return finish({ status: "failed", reason: `cell-metrics-mismatch: width ${comparison.widthDelta.toFixed(2)}px height ${comparison.heightDelta.toFixed(2)}px`, metrics, glyphs, framesWaited });
    }
    if (!glyphs.passed) {
      return finish({ status: "failed", reason: glyphs.failures.map((failure) => `${failure.label}@${failure.column}:${failure.reason}`).join(", "), metrics, glyphs, framesWaited });
    }
    return finish({ status: "passed", reason: null, metrics, glyphs, framesWaited });
  } catch (error) {
    return finish({ status: "unavailable", reason: `probe-error: ${error instanceof Error ? error.message : String(error)}`, metrics: null, glyphs: null, framesWaited: 0 });
  } finally {
    try { webgl?.dispose(); } catch { /* renderer may already be gone */ }
    try { term?.dispose(); } catch { /* terminal may already be gone */ }
    container.remove();
  }
}
