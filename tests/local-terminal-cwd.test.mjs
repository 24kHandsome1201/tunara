import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_TERMINAL_DIR,
  canUseSessionDirForLocalTerminal,
  localTerminalCwdFromSession,
} from "../src/modules/session/local-terminal-cwd.ts";

test("localTerminalCwdFromSession inherits a local session cwd", () => {
  assert.equal(
    localTerminalCwdFromSession({ dir: "/Users/example/project" }),
    "/Users/example/project",
  );
});

test("localTerminalCwdFromSession falls back for missing or remote sessions", () => {
  assert.equal(localTerminalCwdFromSession(null), DEFAULT_LOCAL_TERMINAL_DIR);
  assert.equal(
    localTerminalCwdFromSession({
      dir: "deploy@example.com",
      remote: { host: "example.com", port: 22, user: "deploy" },
    }),
    DEFAULT_LOCAL_TERMINAL_DIR,
  );
});

test("canUseSessionDirForLocalTerminal rejects SSH sessions", () => {
  assert.equal(canUseSessionDirForLocalTerminal(null), false);
  assert.equal(canUseSessionDirForLocalTerminal({ remote: undefined }), true);
  assert.equal(
    canUseSessionDirForLocalTerminal({ remote: { host: "box", port: 22, user: "me" } }),
    false,
  );
});
