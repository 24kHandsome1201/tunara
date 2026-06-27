import assert from "node:assert/strict";
import test from "node:test";

import { setLanguage, t } from "../src/modules/i18n/core.ts";

test("core i18n can be imported without React and translates dictionary keys", () => {
  setLanguage("en");
  assert.equal(t("explorer.refresh"), "Refresh file list");
  setLanguage("zh-CN");
  assert.equal(t("explorer.refresh"), "刷新文件列表");
});

test("core i18n escapes template parameter names before building replacement regex", () => {
  setLanguage("en");
  assert.equal(t("value {{[}} {{a+b}}", { "[": "left", "a+b": "sum" }), "value left sum");
});
