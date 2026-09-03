import assert from "node:assert/strict";
import test from "node:test";

import {
  detectLanguage,
  isAlwaysLogFileName,
  looksLikeLogContent,
} from "../src/modules/editor/language-detect.ts";

test("detectLanguage maps common extensions and Dockerfile names", () => {
  assert.equal(detectLanguage("src/app.ts"), "typescript");
  assert.equal(detectLanguage("App.tsx"), "tsx");
  assert.equal(detectLanguage("index.js"), "javascript");
  assert.equal(detectLanguage("Widget.jsx"), "jsx");
  assert.equal(detectLanguage("package.json"), "json");
  assert.equal(detectLanguage("compose.yaml"), "yaml");
  assert.equal(detectLanguage("Cargo.toml"), "toml");
  assert.equal(detectLanguage("main.rs"), "rust");
  assert.equal(detectLanguage("main.py"), "python");
  assert.equal(detectLanguage("main.go"), "go");
  assert.equal(detectLanguage("setup.sh"), "bash");
  assert.equal(detectLanguage("app.css"), "css");
  assert.equal(detectLanguage("index.html"), "html");
  assert.equal(detectLanguage("query.sql"), "sql");
  assert.equal(detectLanguage("Dockerfile"), "dockerfile");
  assert.equal(detectLanguage("Dockerfile.prod"), "dockerfile");
  assert.equal(detectLanguage("README.md"), "markdown");
  assert.equal(detectLanguage("notes.mdx"), "markdown");
  assert.equal(detectLanguage("app.log"), "log");
  assert.equal(detectLanguage("app.log.3"), "log");
});

test("detectLanguage reads shebangs when the extension is unknown", () => {
  assert.equal(detectLanguage("run", "#!/usr/bin/env python3\nprint(1)\n"), "python");
  assert.equal(detectLanguage("run", "#!/usr/bin/env node\nconsole.log(1)\n"), "javascript");
  assert.equal(detectLanguage("run", "#!/bin/bash\necho hi\n"), "bash");
  assert.equal(detectLanguage("run", "#!/usr/bin/env ts-node\n"), "typescript");
});

test("txt/out/err files become logs only when the sample looks like a log", () => {
  const loggy = Array.from({ length: 10 }, (_, index) => (
    `2026-01-01T00:00:0${index}Z INFO boot ${index}`
  )).join("\n");
  const prose = "hello world\nthis is a notes file\nno timestamps here\n";
  assert.equal(detectLanguage("notes.txt", prose), null);
  assert.equal(detectLanguage("app.out", loggy), "log");
  assert.equal(detectLanguage("app.err", loggy), "log");
  assert.equal(looksLikeLogContent(loggy), true);
  assert.equal(looksLikeLogContent(prose), false);
  assert.equal(isAlwaysLogFileName("app.log.12"), true);
});
