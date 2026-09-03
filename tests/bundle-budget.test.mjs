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

// Baseline measured 2026-09-02 on redesign/perf-lazy after gating
// benchmark hooks and lazy-loading Settings / SshConnect / DiffPanel.
// Production `pnpm build` (Vite 7.3.6). Gzip uses node:zlib's gzip
// (same algorithm as Vite's build reporter: promisify(gzip) from node:zlib).
//
// "Entry chunk" is the application bundle `App-*.js` that `src/main.tsx`
// dynamically imports — not the 3 kB `main-*.js` boot stub in index.html.
const ENTRY_CHUNK_GZIP_BASELINE = 170_176;
const TOTAL_JS_GZIP_BASELINE = 420_242;
const GROWTH_FACTOR = 1.05;

// On-demand TextMate grammars and the Shiki JS-regex engine. They must stay
// out of App / FilePreview / DiffPanel; the first-load total ignores them.
const HIGHLIGHTER_CHUNK = /^(?:shiki-highlight|typescript|tsx|javascript|jsx|json|yaml|toml|rust|python|go|bash|css|html|sql|dockerfile)-.*\.js$/;

const entryBudget = Math.floor(ENTRY_CHUNK_GZIP_BASELINE * GROWTH_FACTOR);
const totalBudget = Math.floor(TOTAL_JS_GZIP_BASELINE * GROWTH_FACTOR);

function listJsAssets() {
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
}

function findNamedChunk(names, prefix) {
  const matches = names.filter((name) => new RegExp(`^${prefix}-.*\\.js$`).test(name));
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${prefix}-*.js chunk in dist/assets, found: ${matches.join(", ") || "(none)"}`,
  );
  return matches[0];
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

  const entryName = findNamedChunk(names, "App");
  const settingsName = findNamedChunk(names, "Settings");
  const sshName = findNamedChunk(names, "SshConnect");
  const diffName = findNamedChunk(names, "DiffPanel");

  const entrySource = readFileSync(path.join(assetsDir, entryName), "utf8");
  assert.doesNotMatch(
    entrySource,
    /Benchmark/,
    `entry chunk ${entryName} still contains Benchmark identifiers`,
  );
  for (const name of [entryName, findNamedChunk(names, "FilePreview"), diffName]) {
    const source = name === entryName ? entrySource : readFileSync(path.join(assetsDir, name), "utf8");
    assert.doesNotMatch(
      source,
      /oniguruma/,
      `${name} must not embed the Oniguruma / WASM engine`,
    );
  }
  assert.doesNotMatch(
    entrySource,
    /shiki/,
    `entry chunk ${entryName} must not contain shiki`,
  );
  assert.ok(
    names.some((name) => name.startsWith("shiki-highlight-")),
    "expected a lazy shiki-highlight-*.js chunk",
  );

  const html = readFileSync(path.join(distDir, "index.html"), "utf8");
  const preloaded = [...html.matchAll(/rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(preloaded.some((href) => href.includes("/react-")), "react chunk should stay modulepreloaded");
  assert.ok(preloaded.some((href) => href.includes("/xterm-")), "xterm chunk should stay modulepreloaded");
  for (const name of [settingsName, sshName, diffName, entryName]) {
    assert.equal(
      preloaded.some((href) => href.endsWith(`/${name}`) || href.endsWith(name)),
      false,
      `${name} should load on demand, not via modulepreload`,
    );
  }

  const entry = sizes.find((row) => row.name === entryName);
  const totalGzip = sizes
    .filter((row) => !HIGHLIGHTER_CHUNK.test(row.name))
    .reduce((sum, row) => sum + row.gzip, 0);

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
