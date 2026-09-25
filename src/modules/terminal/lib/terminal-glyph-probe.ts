/**
 * Pure glyph-probe layout and pixel analysis for the WebGL self-check. No
 * DOM, xterm or Tauri imports so `tests/terminal-renderer-policy.test.mjs`
 * can load it in Node. Kept apart from `terminal-renderer-policy.ts` so the
 * always-loaded decision logic does not drag the probe tables into the entry
 * chunk; only the lazily imported `terminal-glyph-self-check.ts` needs this.
 */

/**
 * One probe glyph: column where it starts, cells it should occupy, which
 * halves of a wide cell must carry ink (`any` for CJK punctuation, whose ink
 * sits in one corner) and the ink colour xterm should draw it with (`null`
 * for colour emoji, which use their own palette).
 */
export interface GlyphProbeCell {
  label: string;
  column: number;
  width: 1 | 2;
  inkHalves: "both" | "any";
  color: RgbColor | null;
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export const PROBE_FOREGROUND: RgbColor = { r: 255, g: 255, b: 255 };
export const PROBE_BACKGROUND: RgbColor = { r: 0, g: 0, b: 0 };
const PROBE_RED: RgbColor = { r: 255, g: 0, b: 0 };
const PROBE_GREEN: RgbColor = { r: 0, g: 255, b: 0 };
const PROBE_BLUE: RgbColor = { r: 0, g: 0, b: 255 };

/**
 * Mixed-width probe row. CJK ideographs, CJK punctuation, an emoji, box
 * drawing, accented Latin and three ANSI-coloured Latin runs, separated by
 * blank columns so bleed into a neighbour is detectable. `text` is the SGR
 * sequence xterm renders; `cells` is what every glyph should occupy.
 */
export interface GlyphProbeLayout {
  text: string;
  cells: readonly GlyphProbeCell[];
  columns: number;
}

export function buildGlyphProbeLayout(): GlyphProbeLayout {
  const cells: GlyphProbeCell[] = [];
  let column = 0;
  let text = "";
  const put = (glyph: string, label: string, width: 1 | 2, inkHalves: "both" | "any", color: RgbColor | null, sgr?: string) => {
    if (sgr) text += `\u001b[${sgr}m`;
    text += glyph;
    if (sgr) text += "\u001b[0m";
    cells.push({ label, column, width, inkHalves, color });
    column += width;
    text += " ";
    column += 1;
  };
  put("中", "cjk-ideograph", 2, "both", PROBE_FOREGROUND);
  put("界", "cjk-ideograph-2", 2, "both", PROBE_FOREGROUND);
  put("，", "cjk-punctuation", 2, "any", PROBE_FOREGROUND);
  put("🐟", "emoji", 2, "both", null);
  put("┌", "box-drawing", 1, "both", PROBE_FOREGROUND);
  put("é", "latin-accented", 1, "both", PROBE_FOREGROUND);
  put("M", "latin-red", 1, "both", PROBE_RED, "38;2;255;0;0");
  put("W", "latin-green", 1, "both", PROBE_GREEN, "38;2;0;255;0");
  put("g", "latin-blue", 1, "both", PROBE_BLUE, "38;2;0;0;255");
  return { text, cells, columns: column + 1 };
}

/** Per-column ink statistics sampled from the rendered probe row. */
export interface ColumnInkSample {
  /** Fraction of pixels in the column's cell that differ from the background. */
  coverage: number;
  /** Mean colour of the inked pixels, or null when the cell is blank. */
  meanInk: RgbColor | null;
}

export interface GlyphProbeAnalysisOptions {
  /** Minimum ink coverage for a cell that should contain a glyph. */
  minGlyphCoverage?: number;
  /** Maximum ink coverage tolerated in a cell that should stay blank. */
  maxBlankCoverage?: number;
  /** Maximum per-channel distance between the expected and observed ink colour. */
  colorTolerance?: number;
}

export interface GlyphProbeFailure {
  label: string;
  column: number;
  reason: "missing-glyph" | "bleed-into-blank" | "wrong-color" | "wide-glyph-half-missing";
  detail: string;
}

export interface GlyphProbeAnalysis {
  passed: boolean;
  failures: GlyphProbeFailure[];
  inspectedCells: number;
}

function channelDistance(a: RgbColor, b: RgbColor): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/** Anti-aliased edges blend ink with the background; scale so the strongest channel is full to compare hue rather than intensity. */
function normalizeInk(color: RgbColor): RgbColor {
  const peak = Math.max(color.r, color.g, color.b);
  if (peak <= 0) return color;
  const scale = 255 / peak;
  return { r: color.r * scale, g: color.g * scale, b: color.b * scale };
}

/**
 * Compare the sampled columns with the expected layout. Glyph cells must have
 * ink, both halves of a wide glyph must have ink (a wide glyph drawn at a
 * narrow advance leaves its second half empty), separator columns must stay
 * blank (a glyph drawn at the wrong UV or with the wrong advance bleeds), and
 * coloured runs must be drawn in their SGR colour (a stale atlas binding
 * draws another glyph's pixels or the wrong palette entry).
 */
export function analyzeGlyphProbe(
  layout: GlyphProbeLayout,
  columns: readonly ColumnInkSample[],
  options: GlyphProbeAnalysisOptions = {},
): GlyphProbeAnalysis {
  const minGlyphCoverage = options.minGlyphCoverage ?? 0.02;
  const maxBlankCoverage = options.maxBlankCoverage ?? 0.01;
  const colorTolerance = options.colorTolerance ?? 96;
  const failures: GlyphProbeFailure[] = [];
  const occupied = new Set<number>();
  for (const cell of layout.cells) {
    const halves: ColumnInkSample[] = [];
    for (let offset = 0; offset < cell.width; offset += 1) {
      occupied.add(cell.column + offset);
      const sample = columns[cell.column + offset];
      if (sample) halves.push(sample);
    }
    if (halves.length !== cell.width) {
      failures.push({ label: cell.label, column: cell.column, reason: "missing-glyph", detail: "column outside the sampled canvas" });
      continue;
    }
    const totalCoverage = halves.reduce((sum, half) => sum + half.coverage, 0) / halves.length;
    if (totalCoverage < minGlyphCoverage) {
      failures.push({ label: cell.label, column: cell.column, reason: "missing-glyph", detail: `coverage ${totalCoverage.toFixed(4)} < ${minGlyphCoverage}` });
      continue;
    }
    if (cell.width === 2 && cell.inkHalves === "both") {
      // A wide glyph drawn at a narrow advance leaves its second half empty.
      const emptyHalf = halves.findIndex((half) => half.coverage === 0);
      if (emptyHalf >= 0) {
        failures.push({ label: cell.label, column: cell.column, reason: "wide-glyph-half-missing", detail: `half ${emptyHalf} has no ink` });
        continue;
      }
    }
    const ink = averageInk(halves);
    if (cell.color && ink) {
      const observed = normalizeInk(ink);
      if (channelDistance(observed, cell.color) > colorTolerance) {
        failures.push({ label: cell.label, column: cell.column, reason: "wrong-color", detail: `ink rgb(${Math.round(observed.r)},${Math.round(observed.g)},${Math.round(observed.b)}) expected rgb(${cell.color.r},${cell.color.g},${cell.color.b})` });
      }
    }
  }
  for (let column = 0; column < layout.columns && column < columns.length; column += 1) {
    if (occupied.has(column)) continue;
    const sample = columns[column];
    if (sample.coverage > maxBlankCoverage) {
      failures.push({ label: "separator", column, reason: "bleed-into-blank", detail: `coverage ${sample.coverage.toFixed(4)} > ${maxBlankCoverage}` });
    }
  }
  return { passed: failures.length === 0, failures, inspectedCells: Math.min(layout.columns, columns.length) };
}

function averageInk(samples: readonly ColumnInkSample[]): RgbColor | null {
  let weight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const sample of samples) {
    if (!sample.meanInk || sample.coverage <= 0) continue;
    weight += sample.coverage;
    r += sample.meanInk.r * sample.coverage;
    g += sample.meanInk.g * sample.coverage;
    b += sample.meanInk.b * sample.coverage;
  }
  if (weight <= 0) return null;
  return { r: r / weight, g: g / weight, b: b / weight };
}

/**
 * Reduce a row of RGBA pixels to per-column ink samples. `pixels` is the
 * `readPixels`/`getImageData` buffer for the whole canvas (row-major, RGBA);
 * `rowTop`/`rowHeight` select the probe row in device pixels. Pixels within
 * `backgroundTolerance` of `background` count as blank.
 */
export function sampleColumnInk(
  pixels: Uint8Array | Uint8ClampedArray,
  canvasWidth: number,
  cellWidth: number,
  cellHeight: number,
  columnCount: number,
  rowTop: number,
  background: RgbColor,
  backgroundTolerance = 24,
): ColumnInkSample[] {
  const samples: ColumnInkSample[] = [];
  const width = Math.max(1, Math.floor(cellWidth));
  const height = Math.max(1, Math.floor(cellHeight));
  for (let column = 0; column < columnCount; column += 1) {
    const left = Math.floor(column * cellWidth);
    let inked = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = (rowTop + y) * canvasWidth;
      for (let x = 0; x < width; x += 1) {
        const px = left + x;
        if (px >= canvasWidth) continue;
        const index = (rowOffset + px) * 4;
        if (index + 3 >= pixels.length) continue;
        total += 1;
        const pr = pixels[index];
        const pg = pixels[index + 1];
        const pb = pixels[index + 2];
        if (channelDistance({ r: pr, g: pg, b: pb }, background) <= backgroundTolerance) continue;
        inked += 1;
        r += pr;
        g += pg;
        b += pb;
      }
    }
    samples.push({
      coverage: total > 0 ? inked / total : 0,
      meanInk: inked > 0 ? { r: r / inked, g: g / inked, b: b / inked } : null,
    });
  }
  return samples;
}

export interface RendererCellMetrics {
  cellWidth: number;
  cellHeight: number;
}

/**
 * WebGL derives its cell size from the same DOM char measurement but floors
 * it to device pixels, so the two renderers may differ by less than one CSS
 * pixel. A larger gap means the GPU renderer measured a different font (or
 * none) and every wide glyph would drift against the DOM grid.
 */
export function compareRendererMetrics(
  dom: RendererCellMetrics,
  webgl: RendererCellMetrics,
  toleranceCssPx = 1,
): { matched: boolean; widthDelta: number; heightDelta: number } {
  const widthDelta = Math.abs(dom.cellWidth - webgl.cellWidth);
  const heightDelta = Math.abs(dom.cellHeight - webgl.cellHeight);
  return {
    matched: Number.isFinite(widthDelta) && Number.isFinite(heightDelta)
      && dom.cellWidth > 0 && webgl.cellWidth > 0
      && widthDelta <= toleranceCssPx && heightDelta <= toleranceCssPx,
    widthDelta,
    heightDelta,
  };
}
