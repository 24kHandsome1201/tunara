import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("editable previews use the same fingerprint-safe save contract locally and over SSH", () => {
  const preview = read("src/ui/FilePreview.tsx");

  assert.match(preview, /result\?\.kind === "text" && result\.fingerprint/);
  assert.match(preview, /fsWriteTextFile\(filePath, content, fingerprint\)/);
  assert.match(preview, /sshWriteTextFile\(remotePtyId, filePath, content, fingerprint\)/);
  assert.match(preview, /result\.status === "conflict"/);
  assert.match(preview, /setSavedContent\(content\)/);
});

test("dirty drafts keep explicit close, conflict, reload, find, and external escape hatches", () => {
  const preview = read("src/ui/FilePreview.tsx");

  assert.match(preview, /const dirty = content !== savedContent/);
  assert.match(preview, /if \(dirty\) \{\s*setCloseConfirm\(true\)/);
  assert.match(preview, /role="alert"/);
  assert.match(preview, /void reload\(\)/);
  assert.match(preview, /catch \(error\) \{\s*setOperationError\(\{ operation: "reload", kind: classifyFileOperationError\(error\), detail: String\(error\) \}\)/);
  assert.match(preview, /operationError\?\.operation === "reload"/);
  assert.match(preview, /disabled=\{reloadPending\}/);
  assert.match(preview, /event\.key\.toLocaleLowerCase\(\) === "f"/);
  assert.match(preview, /openInEditorWithToast\(externalEditor, filePath\)/);
});

test("file operation errors keep a classified summary and diagnostic detail", async () => {
  const { classifyFileOperationError } = await import("../src/modules/editor/file-operation-error.ts");
  const preview = read("src/ui/FilePreview.tsx");

  assert.equal(classifyFileOperationError("Permission denied (os error 13)"), "permission");
  assert.equal(classifyFileOperationError("SSH connection closed"), "disconnected");
  assert.equal(classifyFileOperationError("editable content exceeds safe limit"), "unsupported");
  assert.equal(classifyFileOperationError(new Error("unclassified backend detail")), "failed");
  assert.equal((preview.match(/detail: String\(error\)/g) ?? []).length, 3);
  assert.match(preview, /title=\{operationError\.detail\}/);
  assert.match(preview, /title=\{readError\.detail\}/);
});

test("the editor ships a line-numbered paper surface with narrow and reduced-motion states", () => {
  const preview = read("src/ui/FilePreview.tsx");
  const styles = read("src/styles/globals.css");

  assert.match(preview, /className="file-editor-lines"/);
  assert.match(preview, /<textarea/);
  assert.match(styles, /\.file-editor-code \{ display: grid; grid-template-columns: 46px minmax\(0, 1fr\)/);
  assert.match(styles, /@container file-editor \(max-width: 460px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /transition:\s*all/);
});

test("Markdown mode switching preserves context and follows the tab keyboard model", () => {
  const preview = read("src/ui/FilePreview.tsx");
  const styles = read("src/styles/globals.css");

  assert.match(preview, /normalizedScrollPosition\(textarea\.scrollTop, textarea\.scrollHeight, textarea\.clientHeight\)/);
  assert.match(preview, /initialScrollRatio=\{previewScrollRatioRef\.current\}/);
  assert.match(preview, /role="tab" aria-controls=/);
  assert.match(preview, /tabIndex=\{mode === "edit" \? 0 : -1\}/);
  assert.match(preview, /event\.key === "ArrowLeft" \|\| event\.key === "Home"/);
  assert.match(preview, /event\.key === "ArrowRight" \|\| event\.key === "End"/);
  assert.match(preview, /role="tabpanel" aria-labelledby=/);
  assert.match(preview, /aria-live="polite" aria-atomic="true"/);
  assert.match(preview, /aria-current=\{active \? "true" : undefined\}/);
  assert.match(styles, /\.markdown-find-match\[data-active="true"\]/);
});
