// Usage: node --experimental-strip-types scripts/renderer-benchmark-compare.mjs <webgl result.json> <dom result.json>
// Prints the WebGL-vs-DOM markdown table recorded in release notes and PRs.
import { readFileSync } from "node:fs";

import {
  compareRendererBenchmarkReports,
  renderRendererComparisonMarkdown,
} from "../src/modules/terminal/lib/terminal-benchmark.ts";

const [webglPath, domPath] = process.argv.slice(2);
if (!webglPath || !domPath) {
  console.error("usage: renderer-benchmark-compare.mjs <webgl result.json> <dom result.json>");
  process.exit(2);
}

const load = (path) => {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed.terminal ?? parsed;
};

const webgl = load(webglPath);
const dom = load(domPath);
if (webgl.renderer !== "webgl" || dom.renderer !== "dom") {
  console.error(`expected a webgl and a dom report, got ${webgl.renderer} and ${dom.renderer}`);
  process.exit(2);
}
console.log(renderRendererComparisonMarkdown(compareRendererBenchmarkReports(webgl, dom)));
