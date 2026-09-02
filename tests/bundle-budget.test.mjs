import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = path.join(repoRoot, "dist");
const assetsDir = path.join(distDir, "assets");

// Baseline measured 2026-09-02 against origin/main @
// 833c48919e4edd1fc89e040e55ed19a5a0c9807f. Production `pnpm build`
// (Vite 7.3.6). Gzip uses node:zlib's gzip (same algorithm as Vite's
// build reporter: promisify(gzip) from node:zlib).
//
// "Entry chunk" is the application bundle `App-*.js` that `src/main.tsx`
// dynamically imports — not the 3 kB `main-*.js` boot stub in index.html.
const ENTRY_CHUNK_GZIP_BASELINE = 198_755;
const TOTAL_JS_GZIP_BASELINE = 428_818;
const GROWTH_FACTOR = 1.1;

const entryBudget = Math.floor(ENTRY_CHUNK_GZIP_BASELINE * GROWTH_FACTOR);
const totalBudget = Math.floor(TOTAL_JS_GZIP_BASELINE * GROWTH_FACTOR);

function listJsAssets() {
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
}

function findEntryChunk(names) {
  const app = names.filter((name) => /^App-.*\.js$/.test(name));
  assert.equal(
    app.length,
    1,
    `expected exactly one App-*.js application chunk in dist/assets, found: ${app.join(", ") || "(none)"}`,
  );
  return app[0];
}

test("frontend JS gzip stays within the measured production budget", async (t) => {
  if (!existsSync(distDir) || !existsSync(assetsDir)) {
    t.skip("dist/ is missing; run `pnpm build` first (or `pnpm test:bundle`)");
    return;
  }

  const names = listJsAssets();
  assert.ok(names.length > 0, "dist/assets contains no JS chunks");

  const sizes = [];
  for (const name of names) {
    const buf = readFileSync(path.join(assetsDir, name));
    const compressed = await gzipAsync(buf);
    sizes.push({ name, raw: buf.length, gzip: compressed.length });
  }

  const entryName = findEntryChunk(names);
  const entry = sizes.find((row) => row.name === entryName);
  const totalGzip = sizes.reduce((sum, row) => sum + row.gzip, 0);

  assert.ok(
    entry.gzip <= entryBudget,
    `entry chunk ${entryName} gzip ${entry.gzip} B exceeds budget ${entryBudget} B ` +
      `(baseline ${ENTRY_CHUNK_GZIP_BASELINE} B × ${GROWTH_FACTOR})`,
  );
  assert.ok(
    totalGzip <= totalBudget,
    `total JS gzip ${totalGzip} B exceeds budget ${totalBudget} B ` +
      `(baseline ${TOTAL_JS_GZIP_BASELINE} B × ${GROWTH_FACTOR})`,
  );
});
