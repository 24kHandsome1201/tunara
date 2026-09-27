import test from "node:test";
import assert from "node:assert/strict";

import {
  decideTerminalRenderer,
  DEFAULT_TERMINAL_RENDERER,
  glyphSelfCheckKey,
  sanitizeTerminalRendererPreference,
  shouldRunGlyphSelfCheck,
  TERMINAL_RENDERER_PREFERENCES,
} from "../src/modules/terminal/lib/terminal-renderer-policy.ts";
import {
  alignGlyphProbeLayout,
  analyzeGlyphProbe,
  buildGlyphProbeLayout,
  compareRendererMetrics,
  PROBE_BACKGROUND,
  sampleColumnInk,
} from "../src/modules/terminal/lib/terminal-glyph-probe.ts";

test("renderer preference defaults to auto and rejects unknown values", () => {
  assert.equal(DEFAULT_TERMINAL_RENDERER, "auto");
  assert.deepEqual([...TERMINAL_RENDERER_PREFERENCES], ["auto", "gpu", "compat"]);
  assert.equal(sanitizeTerminalRendererPreference("gpu"), "gpu");
  assert.equal(sanitizeTerminalRendererPreference("compat"), "compat");
  assert.equal(sanitizeTerminalRendererPreference("webgl"), "auto");
  assert.equal(sanitizeTerminalRendererPreference("dom"), "auto");
  assert.equal(sanitizeTerminalRendererPreference(undefined), "auto");
  assert.equal(sanitizeTerminalRendererPreference(1), "auto");
});

test("compat always renders with DOM and never probes", () => {
  for (const selfCheck of ["pending", "passed", "failed", "unavailable"]) {
    for (const gpuFault of [null, "context-lost", "init-failed"]) {
      const input = { preference: "compat", selfCheck, gpuFault };
      assert.equal(decideTerminalRenderer(input), "dom");
      assert.equal(shouldRunGlyphSelfCheck(input), false);
    }
  }
});

test("gpu forces WebGL without a self-check and leaves runtime fallback to the addon path", () => {
  for (const selfCheck of ["pending", "passed", "failed", "unavailable"]) {
    const input = { preference: "gpu", selfCheck, gpuFault: null };
    assert.equal(decideTerminalRenderer(input), "webgl");
    assert.equal(shouldRunGlyphSelfCheck(input), false);
  }
  assert.equal(decideTerminalRenderer({ preference: "gpu", selfCheck: "failed", gpuFault: "context-lost" }), "webgl");
});

test("auto stays on DOM until the glyph self-check passes", () => {
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "pending", gpuFault: null }), "dom");
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "failed", gpuFault: null }), "dom");
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "unavailable", gpuFault: null }), "dom");
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "passed", gpuFault: null }), "webgl");
});

test("auto runs the self-check exactly while a verdict is pending", () => {
  assert.equal(shouldRunGlyphSelfCheck({ preference: "auto", selfCheck: "pending", gpuFault: null }), true);
  assert.equal(shouldRunGlyphSelfCheck({ preference: "auto", selfCheck: "passed", gpuFault: null }), false);
  assert.equal(shouldRunGlyphSelfCheck({ preference: "auto", selfCheck: "failed", gpuFault: null }), false);
  assert.equal(shouldRunGlyphSelfCheck({ preference: "auto", selfCheck: "unavailable", gpuFault: null }), false);
  assert.equal(shouldRunGlyphSelfCheck({ preference: "auto", selfCheck: "pending", gpuFault: "context-lost" }), false);
});

test("auto pins the process to DOM after a WebGL fault even if the self-check passed", () => {
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "passed", gpuFault: "context-lost" }), "dom");
  assert.equal(decideTerminalRenderer({ preference: "auto", selfCheck: "passed", gpuFault: "init-failed" }), "dom");
});

test("self-check cache key changes with font family, size and device pixel ratio", () => {
  const base = glyphSelfCheckKey("JetBrains Mono", 14, 2);
  assert.notEqual(base, glyphSelfCheckKey("Menlo", 14, 2));
  assert.notEqual(base, glyphSelfCheckKey("JetBrains Mono", 15, 2));
  assert.notEqual(base, glyphSelfCheckKey("JetBrains Mono", 14, 1));
  assert.equal(base, glyphSelfCheckKey("JetBrains Mono", 14, 2));
});

test("cell metrics must agree within a CSS pixel", () => {
  assert.equal(compareRendererMetrics({ cellWidth: 8.4, cellHeight: 17 }, { cellWidth: 8, cellHeight: 17 }).matched, true);
  assert.equal(compareRendererMetrics({ cellWidth: 8.4, cellHeight: 17 }, { cellWidth: 10, cellHeight: 17 }).matched, false);
  assert.equal(compareRendererMetrics({ cellWidth: 8.4, cellHeight: 17 }, { cellWidth: 8.4, cellHeight: 19 }).matched, false);
  assert.equal(compareRendererMetrics({ cellWidth: 8.4, cellHeight: 17 }, { cellWidth: 0, cellHeight: 17 }).matched, false);
  assert.equal(compareRendererMetrics({ cellWidth: 8.4, cellHeight: 17 }, { cellWidth: Number.NaN, cellHeight: 17 }).matched, false);
});

test("probe layout covers CJK, CJK punctuation, emoji, box drawing, accented Latin and ANSI colours with blank separators", () => {
  const layout = buildGlyphProbeLayout();
  const labels = layout.cells.map((cell) => cell.label);
  assert.deepEqual(labels, [
    "cjk-ideograph", "cjk-ideograph-2", "cjk-punctuation", "emoji", "box-drawing", "latin-accented", "latin-red", "latin-green", "latin-blue",
  ]);
  assert.match(layout.text, /\u001b\[38;2;255;0;0mM\u001b\[0m/);
  let expectedColumn = 0;
  for (const cell of layout.cells) {
    assert.equal(cell.column, expectedColumn);
    expectedColumn += cell.width + 1;
  }
  assert.equal(layout.columns, expectedColumn + 1);
});

function bufferCellsFor(layout, widthOf) {
  const cells = [];
  for (const cell of layout.cells) {
    const width = widthOf(cell);
    cells.push({ chars: cell.glyph, width });
    if (width === 2) cells.push({ chars: "", width: 0 });
    cells.push({ chars: " ", width: 1 });
  }
  cells.push({ chars: " ", width: 1 });
  return cells;
}

test("probe layout re-anchors to the columns xterm actually assigned when emoji is narrow", () => {
  const layout = buildGlyphProbeLayout();
  const unchanged = alignGlyphProbeLayout(layout, bufferCellsFor(layout, (cell) => cell.width));
  assert.deepEqual(unchanged.cells.map((cell) => [cell.column, cell.width]), layout.cells.map((cell) => [cell.column, cell.width]));
  assert.equal(unchanged.columns, layout.columns);

  // xterm's default Unicode 6 tables give U+1F41F width 1, so everything after it moves left by one column.
  const narrowEmoji = alignGlyphProbeLayout(layout, bufferCellsFor(layout, (cell) => (cell.label === "emoji" ? 1 : cell.width)));
  const emoji = narrowEmoji.cells.find((cell) => cell.label === "emoji");
  const box = narrowEmoji.cells.find((cell) => cell.label === "box-drawing");
  const staticBox = layout.cells.find((cell) => cell.label === "box-drawing");
  // The colour emoji still paints across the blank cell after it, so that column is not a separator.
  assert.equal(emoji.width, 2);
  assert.equal(emoji.inkHalves, "any");
  assert.equal(box.column, staticBox.column - 1);
  assert.equal(narrowEmoji.columns, layout.columns - 1);
  const drawn = healthyColumns(narrowEmoji);
  drawn[emoji.column + 1] = ink(0.56, { r: 200, g: 140, b: 60 });
  assert.equal(analyzeGlyphProbe(narrowEmoji, drawn).passed, true);
  drawn[emoji.column] = ink(0);
  drawn[emoji.column + 1] = ink(0);
  assert.equal(analyzeGlyphProbe(narrowEmoji, drawn).passed, false);

  // A buffer that never shows the probe text (e.g. write not flushed) keeps the static layout.
  assert.deepEqual(alignGlyphProbeLayout(layout, [{ chars: " ", width: 1 }]), layout);
});

function ink(coverage, color = { r: 255, g: 255, b: 255 }) {
  return { coverage, meanInk: coverage > 0 ? color : null };
}

function healthyColumns(layout) {
  const columns = Array.from({ length: layout.columns }, () => ink(0));
  for (const cell of layout.cells) {
    const color = cell.color ?? { r: 200, g: 140, b: 60 };
    for (let offset = 0; offset < cell.width; offset += 1) {
      columns[cell.column + offset] = ink(cell.inkHalves === "any" && offset === 0 ? 0.001 : 0.2, color);
    }
  }
  return columns;
}

test("healthy probe render passes; CJK punctuation may leave a half nearly empty", () => {
  const layout = buildGlyphProbeLayout();
  const analysis = analyzeGlyphProbe(layout, healthyColumns(layout));
  assert.deepEqual(analysis.failures, []);
  assert.equal(analysis.passed, true);
  assert.equal(analysis.inspectedCells, layout.columns);
});

test("missing glyphs, wide glyphs drawn at narrow advance, bleed and wrong colours each fail the probe", () => {
  const layout = buildGlyphProbeLayout();
  const cjk = layout.cells.find((cell) => cell.label === "cjk-ideograph");
  const red = layout.cells.find((cell) => cell.label === "latin-red");

  const missing = healthyColumns(layout);
  missing[cjk.column] = ink(0);
  missing[cjk.column + 1] = ink(0);
  assert.deepEqual(analyzeGlyphProbe(layout, missing).failures.map((failure) => failure.reason), ["missing-glyph"]);

  const halfMissing = healthyColumns(layout);
  halfMissing[cjk.column + 1] = ink(0);
  assert.deepEqual(analyzeGlyphProbe(layout, halfMissing).failures.map((failure) => failure.reason), ["wide-glyph-half-missing"]);

  const bleed = healthyColumns(layout);
  bleed[cjk.column + 2] = ink(0.05);
  assert.deepEqual(analyzeGlyphProbe(layout, bleed).failures.map((failure) => [failure.reason, failure.column]), [["bleed-into-blank", cjk.column + 2]]);

  const wrongColor = healthyColumns(layout);
  wrongColor[red.column] = ink(0.2, { r: 30, g: 200, b: 30 });
  assert.deepEqual(analyzeGlyphProbe(layout, wrongColor).failures.map((failure) => failure.reason), ["wrong-color"]);

  const antiAliasedRed = healthyColumns(layout);
  antiAliasedRed[red.column] = ink(0.2, { r: 120, g: 8, b: 8 });
  assert.equal(analyzeGlyphProbe(layout, antiAliasedRed).passed, true);

  const truncated = healthyColumns(layout).slice(0, 3);
  assert.equal(analyzeGlyphProbe(layout, truncated).passed, false);
});

test("sampleColumnInk reduces an RGBA canvas row to per-column coverage and mean colour", () => {
  const cellWidth = 4;
  const cellHeight = 2;
  const columns = 3;
  const canvasWidth = cellWidth * columns;
  const pixels = new Uint8ClampedArray(canvasWidth * cellHeight * 4);
  const paint = (x, y, r, g, b) => {
    const index = (y * canvasWidth + x) * 4;
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = 255;
  };
  paint(4, 0, 255, 0, 0);
  paint(5, 1, 255, 0, 0);
  paint(9, 0, 10, 10, 10);
  const samples = sampleColumnInk(pixels, canvasWidth, cellWidth, cellHeight, columns, 0, PROBE_BACKGROUND);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].coverage, 0);
  assert.equal(samples[0].meanInk, null);
  assert.equal(samples[1].coverage, 2 / 8);
  assert.deepEqual(samples[1].meanInk, { r: 255, g: 0, b: 0 });
  assert.equal(samples[2].coverage, 0, "near-background pixels count as blank");
});
