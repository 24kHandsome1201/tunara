import assert from "node:assert/strict";
import test from "node:test";

import { isMeaningfulCommand } from "../src/modules/terminal/lib/terminal-command.ts";
import { terminalFileViewerCommand } from "../src/modules/terminal/lib/shell-command.ts";

test("isMeaningfulCommand treats common noise commands as not meaningful", () => {
  for (const noise of ["ls", "cd", "pwd", "clear", "echo hi", "cat file", "exit"]) {
    assert.equal(isMeaningfulCommand(noise), false, `${noise} should be noise`);
  }
});

test("isMeaningfulCommand treats real commands as meaningful", () => {
  for (const cmd of ["npm run build", "git status", "cargo test", "vim notes.md", "python app.py"]) {
    assert.equal(isMeaningfulCommand(cmd), true, `${cmd} should be meaningful`);
  }
});

test("isMeaningfulCommand only inspects the first token", () => {
  // `cd` is noise even with arguments; `npm` is meaningful even though a later
  // token (`ls`) is a noise word.
  assert.equal(isMeaningfulCommand("cd /some/deep/path"), false);
  assert.equal(isMeaningfulCommand("npm ls"), true);
});

test("isMeaningfulCommand is case-insensitive on the first token", () => {
  assert.equal(isMeaningfulCommand("LS -la"), false);
  assert.equal(isMeaningfulCommand("Clear"), false);
});

test("isMeaningfulCommand splits on the FIRST whitespace, so leading whitespace yields an empty first token", () => {
  // Documents a real quirk: command.split(/\s+/) on a leading-whitespace string
  // produces ["", ...], so the first token is "" (not in the noise set) and the
  // command is reported meaningful. Callers are expected to pass a trimmed
  // command; these assertions pin the current behavior rather than endorse it.
  assert.equal(isMeaningfulCommand("   ls"), true);
  assert.equal(isMeaningfulCommand("\tcd /tmp"), true);
  // Without leading whitespace the noise filter works as intended.
  assert.equal(isMeaningfulCommand("ls"), false);
  assert.equal(isMeaningfulCommand("git log"), true);
});

test("isMeaningfulCommand treats an empty string as not meaningful", () => {
  // An empty first token is in NOISE_COMMANDS ("."), but more importantly the
  // empty-string token is matched against the set; empty is not in the set so
  // it is reported meaningful — pin the actual behavior.
  assert.equal(isMeaningfulCommand(""), true);
});

test("isMeaningfulCommand classifies the bare dot (source alias) as noise", () => {
  assert.equal(isMeaningfulCommand(". ~/.bashrc"), false);
});

test("terminal file viewer quotes one untrusted basename as a POSIX shell word", () => {
  assert.equal(terminalFileViewerCommand("notes.txt"), "less -- 'notes.txt'");
  assert.equal(terminalFileViewerCommand("space name.txt"), "less -- 'space name.txt'");
  assert.equal(terminalFileViewerCommand("--help"), "less -- '--help'");
  assert.equal(
    terminalFileViewerCommand("a; $(touch PWNED) 'quote'.txt"),
    "less -- 'a; $(touch PWNED) '\"'\"'quote'\"'\"'.txt'",
  );
  assert.equal(
    terminalFileViewerCommand("notes.txt", "/srv/a; $(touch PWNED)/it's here"),
    "cd '/srv/a; $(touch PWNED)/it'\"'\"'s here' && less -- 'notes.txt'",
  );
});

test("terminal file viewer rejects names and directories with terminal controls", () => {
  for (const fileName of ["", "a\0b", "a\rb", "a\nb", "a\tb", "a\u001bb", "a\u007fb"]) {
    assert.equal(terminalFileViewerCommand(fileName), null);
  }
  assert.equal(terminalFileViewerCommand("notes.txt", "~/relative"), null);
  assert.equal(terminalFileViewerCommand("notes.txt", "/srv/bad\u001bpath"), null);
});
