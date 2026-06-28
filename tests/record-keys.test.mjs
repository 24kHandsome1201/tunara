import assert from "node:assert/strict";
import test from "node:test";

import {
  getNumberRecordValue,
  hasOwnRecordKey,
  hasTrueRecordKey,
  toggleTrueRecordKey,
} from "../src/state/record-keys.ts";

test("record key helpers ignore inherited prototype keys", () => {
  const record = {};

  assert.equal(hasOwnRecordKey(record, "constructor"), false);
  assert.equal(hasOwnRecordKey(record, "__proto__"), false);
  assert.equal(hasTrueRecordKey(record, "constructor"), false);
  assert.equal(hasTrueRecordKey(record, "__proto__"), false);
});

test("toggleTrueRecordKey treats prototype-like names as ordinary own keys", () => {
  let record = {};

  record = toggleTrueRecordKey(record, "constructor");
  assert.deepEqual(Object.keys(record), ["constructor"]);
  assert.equal(hasTrueRecordKey(record, "constructor"), true);

  record = toggleTrueRecordKey(record, "__proto__");
  assert.deepEqual(Object.keys(record), ["constructor", "__proto__"]);
  assert.equal(hasTrueRecordKey(record, "__proto__"), true);

  record = toggleTrueRecordKey(record, "constructor");
  assert.deepEqual(Object.keys(record), ["__proto__"]);
  assert.equal(hasTrueRecordKey(record, "constructor"), false);

  record = toggleTrueRecordKey(record, "__proto__");
  assert.deepEqual(Object.keys(record), []);
  assert.equal(hasTrueRecordKey(record, "__proto__"), false);
});

test("getNumberRecordValue ignores inherited and non-finite values", () => {
  const inherited = {};

  assert.equal(getNumberRecordValue(inherited, "constructor"), 0);
  assert.equal(getNumberRecordValue(inherited, "__proto__"), 0);

  const values = Object.fromEntries([
    ["constructor", 123],
    ["__proto__", 456],
    ["ok", 789],
    ["nan", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ]);

  assert.equal(getNumberRecordValue(values, "constructor"), 123);
  assert.equal(getNumberRecordValue(values, "__proto__"), 456);
  assert.equal(getNumberRecordValue(values, "ok"), 789);
  assert.equal(getNumberRecordValue(values, "nan", 9), 9);
  assert.equal(getNumberRecordValue(values, "infinite", 9), 9);
  assert.equal(getNumberRecordValue(values, "missing", 9), 9);
});
