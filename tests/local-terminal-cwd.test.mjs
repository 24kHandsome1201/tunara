import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCAL_TERMINAL_DIR,
  canUseSessionDirForLocalTerminal,
  localTerminalCwdFromSession,
  splitTerminalContextFromSession,
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

test("split terminal keeps the active local cwd", () => {
  assert.deepEqual(
    splitTerminalContextFromSession({ dir: "/Users/example/project" }),
    { dir: "/Users/example/project" },
  );
});

test("split terminal keeps SSH transport and remote cwd without aliasing config", () => {
  const remote = {
    host: "example.com",
    port: 2222,
    user: "deploy",
    identityFile: "~/.ssh/id_ed25519",
    injectShellIntegration: true,
  };
  const context = splitTerminalContextFromSession({ dir: "/srv/project", remote });

  assert.deepEqual(context, { dir: "/srv/project", remote });
  assert.notEqual(context.remote, remote, "a split must not alias mutable session transport state");
});

test("split terminal without an active session starts locally at home", () => {
  assert.deepEqual(splitTerminalContextFromSession(null), { dir: DEFAULT_LOCAL_TERMINAL_DIR });
});
