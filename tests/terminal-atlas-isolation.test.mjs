import assert from "node:assert/strict";
import test from "node:test";

test("session ids isolate WebGL atlas cache keys without changing the real font stack", async () => {
  const {
    atlasIsolationFontToken,
    withAtlasIsolationFontFamily,
  } = await import("../src/modules/terminal/lib/terminal-atlas-isolation.ts");

  const base = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';
  assert.equal(withAtlasIsolationFontFamily(base), base);
  assert.equal(withAtlasIsolationFontFamily(base, ""), base);
  assert.equal(atlasIsolationFontToken("session-codex"), "session-codex");

  const a = withAtlasIsolationFontFamily(base, "session-codex");
  const b = withAtlasIsolationFontFamily(base, "session-grok");
  const aAgain = withAtlasIsolationFontFamily(base, "session-codex");

  assert.equal(a, aAgain, "the same session always maps to the same atlas key");
  assert.notEqual(a, b, "split panes must not share an atlas cache key");
  assert.ok(a.startsWith(base), "real fonts stay first so unknown families are ignored");
  assert.match(a, /"tunara-atlas-session-codex"/);
  assert.match(b, /"tunara-atlas-session-grok"/);
});

test("unsafe session ids still produce a CSS-safe unique family name", async () => {
  const { withAtlasIsolationFontFamily } = await import(
    "../src/modules/terminal/lib/terminal-atlas-isolation.ts"
  );
  const isolated = withAtlasIsolationFontFamily("monospace", "pane 1/../evil\";hack");
  assert.match(isolated, /"tunara-atlas-pane1evilhack"/);
});
