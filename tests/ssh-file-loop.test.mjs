import assert from "node:assert/strict";
import test from "node:test";

import { dropDestinationFromListing } from "../src/modules/ssh/drop-target.ts";
import {
  emptyHostFilePrefs,
  hostFilePrefsKey,
  pushHostRecentPath,
  rememberHostDownloadDir,
  sanitizeHostFilePrefs,
  sanitizeHostFilePrefsMap,
  toggleHostFavoritePath,
} from "../src/modules/ssh/host-file-prefs.ts";
import { siblingPreviewPaths } from "../src/modules/editor/sibling-files.ts";
import { parseTabularPreview } from "../src/modules/editor/tabular-preview.ts";

test("host prefs keep bounded favorites, recents, and a local download dir", () => {
  const key = hostFilePrefsKey({ user: "Root", host: "De-Netcup", port: 22 });
  assert.equal(key, "root@de-netcup:22");
  let prefs = emptyHostFilePrefs();
  prefs = pushHostRecentPath(prefs, "/var/log");
  prefs = pushHostRecentPath(prefs, "/tmp");
  prefs = pushHostRecentPath(prefs, "/var/log");
  prefs = toggleHostFavoritePath(prefs, "/var/log");
  prefs = rememberHostDownloadDir(prefs, "/Users/me/Downloads");
  assert.deepEqual(prefs.recentPaths, ["/var/log", "/tmp"]);
  assert.deepEqual(prefs.favoritePaths, ["/var/log"]);
  assert.equal(prefs.lastDownloadDir, "/Users/me/Downloads");
  const dirty = sanitizeHostFilePrefsMap({
    [key]: {
      favoritePaths: ["/ok", "../escape", "/ok", "relative"],
      recentPaths: ["\0bad", "/tmp"],
      lastDownloadDir: "not-absolute",
      followTerminalCwd: false,
    },
    "__proto__": { favoritePaths: ["/x"] },
  });
  assert.equal(dirty[key].followTerminalCwd, false);
  assert.deepEqual(dirty[key].favoritePaths, ["/ok"]);
  assert.deepEqual(dirty[key].recentPaths, ["/tmp"]);
  assert.equal(dirty[key].lastDownloadDir, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(dirty, "__proto__"), false);
});

test("drop targeting uses the hovered directory or the file's parent", () => {
  const nodes = [
    { path: "/srv/app", parentPath: "/srv", kind: "dir" },
    { path: "/srv/app/readme.md", parentPath: "/srv/app", kind: "file" },
    { path: "/srv/app/logs", parentPath: "/srv/app", kind: "dir" },
  ];
  assert.deepEqual(dropDestinationFromListing({
    clientY: 40, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app", highlightPath: "/srv/app" });
  assert.deepEqual(dropDestinationFromListing({
    clientY: 50, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app", highlightPath: "/srv/app" });
  assert.deepEqual(dropDestinationFromListing({
    clientY: 90, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app/logs", highlightPath: "/srv/app/logs" });
});

test("sibling preview walks only regular files in listing order", () => {
  const files = siblingPreviewPaths("/repo/b.txt", [
    { name: "a.txt", kind: "file" },
    { name: "nested", kind: "dir" },
    { name: "b.txt", kind: "file" },
    { name: "c.txt", kind: "file" },
  ]);
  assert.equal(files.previous, "/repo/a.txt");
  assert.equal(files.next, "/repo/c.txt");
});

test("delimited preview normalizes uneven rows", () => {
  for (const [fileName, delimiter] of [["dump.csv", ","], ["dump.tsv", "\t"]]) {
    const table = parseTabularPreview(fileName, ["a,b", "1,2,3", "4"].join("\n").replaceAll(",", delimiter));
    assert.deepEqual(table?.columns, ["a", "b", "col3"]);
    assert.deepEqual(table?.rows, [["1", "2", "3"], ["4", "", ""]]);
    assert.equal(table?.columnCount, 3);
    assert.equal(table?.truncated, false);
  }
});

test("delimited generated headers avoid existing names", () => {
  const table = parseTabularPreview("dump.csv", ",col1,col4,col4_2\nx,y,z,w,5\n6");
  assert.deepEqual(table?.columns, ["col1_2", "col1", "col4", "col4_2", "col5"]);
  assert.deepEqual(table?.rows[1], ["6", "", "", "", ""]);
});

test("delimited width includes rows beyond the display limit", () => {
  const wide = Array.from({ length: 42 }, (_, index) => String(index)).join(",");
  const table = parseTabularPreview("dump.csv", ["a", ...Array(200).fill("1"), wide].join("\n"));
  assert.equal(table?.columnCount, 42);
  assert.equal(table?.columns.length, 40);
  assert.equal(table?.rows.length, 200);
  assert.ok(table?.rows.every((row) => row.length === 40 && row[1] === ""));
  assert.equal(table?.truncated, true);
  assert.equal(parseTabularPreview("dump.csv", ""), null);
  assert.equal(parseTabularPreview("dump.csv", 'a,b\n"unfinished'), null);
  assert.deepEqual(parseTabularPreview("dump.csv", "a,b")?.rows, []);
});

test("delimited previews preserve all output when the widest rows are hidden", () => {
  for (const [kind, delimiter] of [["csv", ","], ["tsv", "\t"]]) {
    const fileName = `dump.${kind}`;
    const longCell = "x".repeat(241);
    const visible = Array.from({ length: 199 }, (_, index) => String(index));
    const content = `\r\n\n${delimiter}col1${delimiter}col4\r`
      + `"${delimiter}\r\n\r\n"""${delimiter}${longCell}\r\n`
      + `${visible.join("\n")}\n\n`;
    const wide = delimiter.repeat(41);
    const columns = [
      "col1_2", "col1", "col4", "col4_2",
      ...Array.from({ length: 36 }, (_, index) => `col${index + 5}`),
    ];
    assert.deepEqual(parseTabularPreview(fileName, content + wide), {
      kind,
      columns,
      rows: [
        [`${delimiter}\r\n\r\n"`, `${"x".repeat(240)}…`, ...Array(38).fill("")],
        ...visible.map((value) => [value, ...Array(39).fill("")]),
      ],
      rowCount: 202,
      columnCount: 42,
      truncated: true,
    });
    assert.equal(parseTabularPreview(fileName, content + wide + '"unfinished'), null);
    assert.equal(parseTabularPreview(fileName, ""), null);
  }
});

test("tabular preview stays text-only for json and csv", () => {
  const json = parseTabularPreview("users.json", JSON.stringify([{ id: 1, name: "<script>" }, { id: 2, name: "ok" }]));
  assert.equal(json?.kind, "json");
  assert.deepEqual(json?.columns, ["id", "name"]);
  assert.equal(json?.rows[0][1], "<script>");
  const csv = parseTabularPreview("dump.csv", "a,b\n1,\"quoted,value\"\n2,x");
  assert.equal(csv?.kind, "csv");
  assert.deepEqual(csv?.rows[0], ["1", "quoted,value"]);
  assert.equal(parseTabularPreview("notes.md", "a,b"), null);
});

test("tabular preview handles CR line breaks", () => {
  for (const content of ["a,b\r1,2\r3,4", "a,b\r\n1,2\r3,4\n"]) {
    const csv = parseTabularPreview("dump.csv", content);
    assert.deepEqual(csv?.columns, ["a", "b"]);
    assert.deepEqual(csv?.rows, [["1", "2"], ["3", "4"]]);
  }
});

test("tabular preview preserves quoted line breaks", () => {
  const csv = parseTabularPreview("dump.csv", 'a,b\r\n1,"x\ry\r\nz\nw"\r2,end');
  assert.deepEqual(csv?.columns, ["a", "b"]);
  assert.deepEqual(csv?.rows, [["1", "x\ry\r\nz\nw"], ["2", "end"]]);
});

test("tabular preview counts columns beyond the display limit across all objects", () => {
  const record = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`key${i}`, i]));
  const table = parseTabularPreview("wide.json", JSON.stringify([record, { later: true }]));
  assert.equal(table.columnCount, 56);
  assert.equal(table.columns.length, 40);
  assert.equal(table.rows[0].length, 40);
  assert.equal(table.rowCount, 2);
  assert.equal(table.truncated, true);
});

test("JSONL counts every nonblank record and validates records beyond the display limit", () => {
  const content = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: i })).join("\n\n");
  const table = parseTabularPreview("records.jsonl", content);
  assert.equal(table.rowCount, 300);
  assert.equal(table.rows.length, 200);
  assert.equal(table.truncated, true);
  assert.equal(parseTabularPreview("records.jsonl", `${content}\ninvalid`), null);
});

test("tabular totals describe empty and untruncated tables", () => {
  const table = parseTabularPreview("empty.json", "[]");
  assert.equal(table.rowCount, 0);
  assert.equal(table.columnCount, 1);
  assert.equal(table.truncated, false);
  assert.equal(parseTabularPreview("blank.jsonl", "\n\n"), null);
});
