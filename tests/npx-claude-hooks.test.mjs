import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const scripts = { bash: "bashrc.bash", zsh: "zshrc.zsh", fish: "config.fish" };

for (const [shell, script] of Object.entries(scripts)) {
  test(`${shell}: npx Claude hooks, passthrough, user functions and aliases`, (t) => {
    if (spawnSync(shell, ["--version"]).error) return t.skip(`${shell} not installed`);
    const dir = mkdtempSync(join(tmpdir(), "tunara-npx-"));
    try {
      mkdirSync(join(dir, "config"));
      writeFileSync(join(dir, "config", "agent-hook.sh"), "");
      writeFileSync(join(dir, "npx"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const index = args.indexOf("--plugin-dir");
const plugin = index < 0 ? null : JSON.parse(fs.readFileSync(args[index + 1] + "/hooks/hooks.json", "utf8"));
fs.writeFileSync(process.env.RECORD, JSON.stringify({ args, plugin, stdin: fs.readFileSync(0, "utf8") }));
process.exit(Number(process.env.STUB_EXIT || 0));
`, { mode: 0o755 });
      const run = (command, { setup = "", missing = false, exit = 0 } = {}) => {
        const result = spawnSync(shell, shell === "bash" ? ["--noprofile", "--norc", "-ic",
          `${setup}\nsource "${root}/src-tauri/src/modules/pty/scripts/${script}"\n${command}`] :
          [shell === "zsh" ? "-f" : "--no-config", "-ic",
            `${setup}\nsource "${root}/src-tauri/src/modules/pty/scripts/${script}"\neval '${command}'`], {
          cwd: dir, input: "stdin preserved\n", encoding: "utf8",
          env: { ...process.env, HOME: dir, TUNARA_USER_ZDOTDIR: dir, __TUNARA_HOOKS_LOADED: "1",
            PATH: `${dir}:${process.env.PATH}`, TUNARA_SESSION_ID: "test-session",
            TUNARA_AGENT_CONFIG_DIR: missing ? join(dir, "missing") : join(dir, "config"),
            TUNARA_HOOKS_SOCK: "", RECORD: join(dir, "record"), STUB_EXIT: String(exit) },
        });
        assert.equal(result.status, exit, result.stderr);
        const record = JSON.parse(readFileSync(join(dir, "record"), "utf8"));
        assert.equal(record.stdin, "stdin preserved\n");
        assert.deepEqual(readdirSync(join(dir, "config")), ["agent-hook.sh"]);
        return record;
      };
      for (const args of [
        ["@anthropic-ai/claude-code"], ["-y", "@anthropic-ai/claude-code@latest"],
        ["claude"], ["claude@latest"], ["CLAUDE"], ["./Claude@latest"],
        ["--package", "example", "--cache", "cache", "claude"],
        ["-p", "example", "--yes", "@anthropic-ai/claude-code@1.2.3"],
      ]) {
        const record = run(`npx ${args.join(" ")} --settings user.json "hello world"`, { exit: 7 });
        assert.deepEqual(record.args.slice(0, args.length), args);
        assert.equal(record.args[args.length], "--plugin-dir");
        assert.deepEqual(record.args.slice(args.length + 2), ["--settings", "user.json", "hello world"]);
        for (const hook of ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "Notification"]) {
          assert.ok(record.plugin.hooks[hook], hook);
        }
      }
      for (const args of [
        ["prettier", "--version"], ["-y", "cowsay", "hi"], ["--call", "claude"],
        ["--package", "@anthropic-ai/claude-code", "prettier", "--version"],
        ["@anthropic-ai/claude-code-other"], ["claude@"], ["--yes"],
      ]) {
        const record = run(`npx ${args.join(" ")} "" "two words"`, { exit: 9 });
        assert.deepEqual(record.args, [...args, "", "two words"]);
        assert.equal(record.plugin, null);
      }
      assert.deepEqual(run("npx claude hello", { missing: true }).args, ["claude", "hello"]);
      assert.deepEqual(run("npx").args, []);
      const setup = shell === "fish" ? "function npx; command npx $argv; end" : "npx() { command npx \"$@\"; }";
      assert.ok(run("npx claude", { setup }).plugin);
      assert.deepEqual(run("npx prettier --version", { setup }).args, ["prettier", "--version"]);
      const alias = "alias npx='npx --yes'";
      assert.ok(run("npx claude", { setup: alias }).plugin);
      assert.deepEqual(run("npx prettier --version", { setup: alias }).args, ["--yes", "prettier", "--version"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
