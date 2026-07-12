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
  assert.match(preview, /event\.key\.toLocaleLowerCase\(\) === "f"/);
  assert.match(preview, /openInEditorWithToast\(externalEditor, filePath\)/);
});

test("the editor ships a line-numbered paper surface with narrow and reduced-motion states", () => {
  const preview = read("src/ui/FilePreview.tsx");
  const styles = read("src/styles/globals.css");

  assert.match(preview, /className="file-editor-lines"/);
  assert.match(preview, /<textarea/);
  assert.match(styles, /\.file-editor-code \{ display: grid; grid-template-columns: 46px minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 460px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /transition:\s*all/);
});
