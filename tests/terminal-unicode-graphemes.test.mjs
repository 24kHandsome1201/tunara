import assert from "node:assert/strict";
import test from "node:test";

import xterm from "@xterm/xterm";
import { registerTerminalUnicodeGraphemes, TERMINAL_UNICODE_GRAPHEMES_VERSION } from "../src/modules/terminal/lib/terminal-unicode.ts";

const { Terminal } = xterm;

function createTerminal() {
  return new Terminal({ allowProposedApi: true, cols: 80, rows: 5 });
}

function writeAndReadCells(term, text) {
  return new Promise((resolve) => {
    term.write(text + "\r\n", () => {
      const line = term.buffer.active.getLine(0);
      const cells = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (cell && cell.getChars()) {
          cells.push({ column: x, chars: cell.getChars(), width: cell.getWidth() });
        }
      }
      resolve(cells);
    });
  });
}

test("grapheme addon registers Unicode 15 providers and activates the grapheme version", async () => {
  const term = createTerminal();
  assert.deepEqual([...term.unicode.versions], ["6"]);
  assert.equal(term.unicode.activeVersion, "6");

  const dispose = await registerTerminalUnicodeGraphemes(term);
  assert.ok(term.unicode.versions.includes("15"));
  assert.ok(term.unicode.versions.includes(TERMINAL_UNICODE_GRAPHEMES_VERSION));
  assert.equal(term.unicode.activeVersion, TERMINAL_UNICODE_GRAPHEMES_VERSION);

  dispose();
  assert.equal(term.unicode.activeVersion, "6");
});

test("ZWJ emoji family occupies a single wide cell instead of one cell per codepoint", async () => {
  const family = "👨‍👩‍👧‍👦"; // man + ZWJ + woman + ZWJ + girl + ZWJ + boy
  const plain = await writeAndReadCells(createTerminal(), family + "x");
  assert.equal(plain.length, 5); // four narrow emoji cells + x
  assert.ok(plain.slice(0, 4).every((cell) => cell.width === 1));

  const term = createTerminal();
  const dispose = await registerTerminalUnicodeGraphemes(term);
  const graphemes = await writeAndReadCells(term, family + "x");
  assert.deepEqual(graphemes, [
    { column: 0, chars: family, width: 2 },
    { column: 2, chars: "x", width: 1 },
  ]);
  dispose();
});

test("regional-indicator flag pairs render as one wide cell", async () => {
  const flag = "🇩🇪";
  const plain = await writeAndReadCells(createTerminal(), flag + "x");
  assert.equal(plain.length, 3); // two separate indicator letters + x

  const term = createTerminal();
  const dispose = await registerTerminalUnicodeGraphemes(term);
  const graphemes = await writeAndReadCells(term, flag + "x");
  assert.deepEqual(graphemes, [
    { column: 0, chars: flag, width: 2 },
    { column: 2, chars: "x", width: 1 },
  ]);
  dispose();
});

test("skin-tone modifiers merge into the base emoji cell", async () => {
  const waved = "👋🏽";
  const plain = await writeAndReadCells(createTerminal(), waved + "x");
  assert.equal(plain.length, 3); // emoji + standalone modifier cell + x

  const term = createTerminal();
  const dispose = await registerTerminalUnicodeGraphemes(term);
  const graphemes = await writeAndReadCells(term, waved + "x");
  assert.deepEqual(graphemes, [
    { column: 0, chars: waved, width: 2 },
    { column: 2, chars: "x", width: 1 },
  ]);
  dispose();
});

test("emoji presentation selector widens the cell to two columns", async () => {
  const heart = "❤️"; // U+2764 U+FE0F
  const plain = await writeAndReadCells(createTerminal(), heart + "x");
  assert.equal(plain[0].width, 1); // treated as text presentation before

  const term = createTerminal();
  const dispose = await registerTerminalUnicodeGraphemes(term);
  const graphemes = await writeAndReadCells(term, heart + "x");
  assert.deepEqual(graphemes, [
    { column: 0, chars: heart, width: 2 },
    { column: 2, chars: "x", width: 1 },
  ]);
  dispose();
});

test("CJK characters and fullwidth punctuation keep two-column cells, matching the space-all rule", async () => {
  const cjk = "中文，。";
  const term = createTerminal();
  const dispose = await registerTerminalUnicodeGraphemes(term);
  const cells = await writeAndReadCells(term, cjk);
  assert.deepEqual(cells, [
    { column: 0, chars: "中", width: 2 },
    { column: 2, chars: "文", width: 2 },
    { column: 4, chars: "，", width: 2 },
    { column: 6, chars: "。", width: 2 },
  ]);
  dispose();
});
