import assert from "node:assert/strict";
import test from "node:test";

import { highlightLogSource } from "../src/modules/editor/log-syntax.ts";

function reconstruct(lines) {
  return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

function kindsOn(line) {
  return line.filter((segment) => segment.kind !== "text").map((segment) => [segment.kind, segment.text]);
}

const NGINX =
  '127.0.0.1 - - [01/Jan/2026:12:00:01 +0000] "GET /health HTTP/1.1" 200 12 "https://example.com/"';
const JOURNALD = "Jan  1 12:00:01 host sshd[142]: Failed password for root from 2001:db8::1";
const PYTHON = `Traceback (most recent call last):
  File "app.py", line 42, in <module>
ValueError: boom`;
const TRACING = "2026-01-01T12:00:01.123Z  ERROR tunara::fs: write failed count=3";
const DEBUG_LINE = "2026-01-01T12:00:01Z DEBUG worker idle";
const WARN_LINE = "2026-01-01T12:00:01Z WARN disk almost full";

test("log highlighting preserves every source byte", () => {
  const source = [NGINX, JOURNALD, PYTHON, TRACING, DEBUG_LINE, WARN_LINE].join("\n");
  const highlighted = highlightLogSource(source);
  assert.equal(reconstruct(highlighted), source);
});

test("nginx access lines color timestamp, IP, URL, quoted strings, and status numbers", () => {
  const [line] = highlightLogSource(NGINX);
  const kinds = Object.fromEntries(kindsOn(line).map(([kind]) => [kind, true]));
  assert.equal(kinds["log-timestamp"], true);
  assert.equal(kinds["log-ip"], true);
  assert.equal(kinds["log-url"], true);
  assert.equal(kinds["log-string"], true);
  assert.equal(kinds["log-number"], true);
});

test("journald, python traceback, and rust tracing color levels and addresses", () => {
  const journald = highlightLogSource(JOURNALD)[0];
  assert.ok(kindsOn(journald).some(([kind, text]) => kind === "log-timestamp" && text.includes("Jan")));
  assert.ok(kindsOn(journald).some(([kind, text]) => kind === "log-ip" && text.includes("2001:db8")));

  const traceback = highlightLogSource(PYTHON);
  assert.ok(traceback[0].some((segment) => segment.kind === "log-error" && segment.text === "Traceback"));
  assert.ok(traceback[1].some((segment) => segment.kind === "log-number" && segment.text === "42"));

  const tracing = highlightLogSource(TRACING)[0];
  assert.ok(tracing.some((segment) => segment.kind === "log-error" && segment.text === "ERROR"));
  assert.ok(tracing.some((segment) => segment.kind === "log-timestamp"));
  assert.ok(tracing.some((segment) => segment.kind === "log-number" && segment.text === "3"));

  const debug = highlightLogSource(DEBUG_LINE)[0];
  assert.ok(debug.some((segment) => segment.kind === "log-debug" && segment.text === "DEBUG"));
  const warn = highlightLogSource(WARN_LINE)[0];
  assert.ok(warn.some((segment) => segment.kind === "log-warn" && segment.text === "WARN"));
});
