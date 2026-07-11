import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("shell wrappers emit explicit lifecycle events and only inject settings when hooks are available", () => {
  for (const path of [
    "src-tauri/src/modules/pty/scripts/zshrc.zsh",
    "src-tauri/src/modules/pty/scripts/bashrc.bash",
  ]) {
    const script = read(path);
    assert.match(script, /if \[\[? -n "\$TUNARA_SESSION_ID"/);
    assert.match(script, /_tunara_agent_osc\(\)/);
    assert.match(script, /printf '\\e\]777;tunara-agent;%s;%s;%s;%s\\e\\\\'/);
    assert.match(script, /_tunara_agent_emit start "\$agent"/);
    assert.match(script, /_tunara_agent_emit exit "\$agent" "\$ret"/);
    assert.match(script, /TUNARA_HOOKS_SOCK[\s\S]*return 0/);
    assert.match(script, /TUNARA_AGENT_CONFIG_DIR/);
    assert.match(script, /mktemp -d "\$config_dir\/tunara-agent-\$\{sid\}\.XXXXXX"/);
    assert.match(script, /chmod 700 "\$runtime"/);
    assert.match(script, /\.claude-plugin/);
    assert.match(script, /hooks\/hooks\.json/);
    // The lifecycle hooks reference the host-written helper; the stdin parsing
    // and socket relay live in agent-hook.sh, not inline in the shell wrapper.
    assert.match(script, /helper="\$config_dir\/agent-hook\.sh"/);
    assert.match(script, /helper_command=/);
    assert.match(script, /TUNARA_AGENT_CONFIG_DIR\/agent-hook\.sh/);
    assert.match(script, /\$\{helper_command\} idle \$\{agent\} \$\{sid\}/);
    assert.match(script, /\$\{helper_command\} busy \$\{agent\} \$\{sid\}/);
    assert.match(script, /\$\{helper_command\} stop \$\{agent\} \$\{sid\}/);
    assert.doesNotMatch(script, /if \[\[? -n "\$sock"/);
    // The injected settings JSON must not inline a printf|nc hook command — the
    // stdin parsing + socket relay live in agent-hook.sh now. (The start/exit
    // lifecycle emit still uses nc directly, so we only forbid the inline hook.)
    assert.doesNotMatch(script, /"command":"printf/);
    assert.doesNotMatch(script, /\/tmp\/tunara-agent/);
    assert.match(script, /command "\$real_bin" --plugin-dir "\$runtime" "\$@"/);
    assert.match(script, /merge-settings "\$user_settings" "\$settings" "\$merged"/);
    assert.match(script, /command "\$real_bin" --settings "\$settings" "\$\{forwarded\[@\]\}"/);
    assert.match(script, /else[\s\S]*command "\$real_bin" "\$@"/);
    assert.match(script, /function claude \{ _tunara_agent_run claude CC/);
    assert.match(script, /unalias claude droid codex 2>\/dev\/null/);
    assert.match(script, /function droid \{ _tunara_agent_run droid DR/);
    assert.match(script, /function codex \{ _tunara_agent_plain_run codex CX/);
    assert.doesNotMatch(script, /\bfunction codex \{ _tunara_agent_run codex/);
    assert.doesNotMatch(script, /\bdevin\(\) \{ _tunara_agent_run devin/);
    assert.match(script, /"SessionStart":\[\{"matcher":"startup\|resume"/);
    assert.match(script, /"UserPromptSubmit":\[\{"hooks"/);
    assert.match(script, /"StopFailure":\[\{"hooks"/);
  }
});

test("remote integration can replace pre-existing aliases in bash", () => {
  const script = resolve(root, "src-tauri/src/modules/ssh/scripts/remote-integration.sh");
  const bashOutput = execFileSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-O",
      "expand_aliases",
      "-c",
      'alias claude="claude --model opus"; alias codex="codex --profile work"; source "$1"; _tunara_r_agent_run() { printf "WRAPPED %s\\n" "$*"; }; _tunara_r_agent_plain_run() { printf "WRAPPED %s\\n" "$*"; }; eval "claude hello"; eval "codex go"',
      "bash",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.match(bashOutput, /WRAPPED claude CC --model opus hello/);
  assert.match(bashOutput, /WRAPPED codex CX --profile work go/);
});

const hasZsh = spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0;

test("remote integration can replace pre-existing aliases in zsh", { skip: !hasZsh }, () => {
  const script = resolve(root, "src-tauri/src/modules/ssh/scripts/remote-integration.sh");
  const zshOutput = execFileSync(
    "zsh",
    [
      "-f",
      "-c",
      'alias claude="claude --model opus"; alias codex="codex --profile work"; source "$1"; _tunara_r_agent_run() { print -r -- "WRAPPED $*"; }; _tunara_r_agent_plain_run() { print -r -- "WRAPPED $*"; }; eval "claude hello"; eval "codex go"',
      "zsh",
      script,
    ],
    { encoding: "utf8" },
  );
  assert.match(zshOutput, /WRAPPED claude CC --model opus hello/);
  assert.match(zshOutput, /WRAPPED codex CX --profile work go/);
});

test("agent-hook helper extracts the real session_id and relays it as agent_session_id", () => {
  const helper = read("src-tauri/src/modules/agent/scripts/agent-hook.sh");
  // jq-free, field-name-anchored extraction so look-alike keys are not matched.
  assert.match(helper, /grep '"session_id"'/);
  assert.match(helper, /cut -d'"' -f4/);
  assert.match(helper, /\*\[!A-Za-z0-9_-\]\*/);
  assert.match(helper, /"\$\{#asid\}" -le 256/);
  assert.match(helper, /"agent_session_id":"%s"/);
  assert.match(helper, /777;tunara-agent[\s\S]*> \/dev\/tty/);
  assert.match(helper, /nc -U "\$TUNARA_HOOKS_SOCK"/);
  // The socket is optional because OSC 777 is the local fallback.
  assert.match(helper, /> \/dev\/tty[\s\S]*\[ -n "\$TUNARA_HOOKS_SOCK" \] \|\| exit 0/);

  // The host ships and locks down the helper at startup.
  const hooks = read("src-tauri/src/modules/agent/hooks.rs");
  assert.match(hooks, /const AGENT_HOOK_SH: &str = include_str!\("scripts\/agent-hook\.sh"\)/);
  assert.match(hooks, /write_agent_hook_helper\(&sock_dir\)/);
  assert.match(hooks, /from_mode\(0o500\)/);
  // The id rides through the payload and the emitted event.
  assert.match(hooks, /agent_session_id: Option<String>/);
  assert.match(hooks, /rename = "agentSessionId"/);
});

test("agent-hook helper preserves user settings and appends Tunara hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-settings-merge-"));
  try {
    const user = join(dir, "user.json");
    const tunara = join(dir, "tunara.json");
    const output = join(dir, "merged.json");
    writeFileSync(user, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Read"] },
      hooks: { SessionStart: [{ matcher: "user", hooks: [{ type: "command", command: "user-hook" }] }] },
    }));
    writeFileSync(tunara, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "tunara", hooks: [{ type: "command", command: "tunara-start" }] }],
        Stop: [{ hooks: [{ type: "command", command: "tunara-stop" }] }],
      },
    }));
    execFileSync("sh", [
      resolve(root, "src-tauri/src/modules/agent/scripts/agent-hook.sh"),
      "merge-settings",
      user,
      tunara,
      output,
    ]);
    const merged = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(merged.model, "opus");
    assert.deepEqual(merged.permissions, { allow: ["Read"] });
    assert.deepEqual(merged.hooks.SessionStart.map((entry) => entry.matcher), ["user", "tunara"]);
    assert.equal(merged.hooks.Stop[0].hooks[0].command, "tunara-stop");
    assert.throws(() => execFileSync("sh", [
      resolve(root, "src-tauri/src/modules/agent/scripts/agent-hook.sh"),
      "merge-settings",
      '{"hooks":false}',
      tunara,
      join(dir, "invalid.json"),
    ], { stdio: "ignore" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash wrapper composes Claude plugins and Droid user settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-wrapper-"));
  try {
    const configDir = join(dir, "runtime");
    const binDir = join(dir, "bin");
    mkdirSync(configDir);
    mkdirSync(binDir);
    writeFileSync(
      join(configDir, "agent-hook.sh"),
      read("src-tauri/src/modules/agent/scripts/agent-hook.sh"),
      { mode: 0o500 },
    );
    const fakeAgent = `#!/bin/sh
printf 'CALL:%s\\n' "\${0##*/}"
settings_count=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plugin-dir)
      [ -f "$2/.claude-plugin/plugin.json" ] && [ -f "$2/hooks/hooks.json" ] && printf 'PLUGIN:ok\\n'
      shift 2
      ;;
    --settings)
      settings_count=$((settings_count + 1))
      printf 'SETTINGS:%s\\n' "$(cat "$2")"
      shift 2
      ;;
    *) printf 'ARG:%s\\n' "$1"; shift ;;
  esac
done
printf 'SETTINGS_COUNT:%s\\n' "$settings_count"
`;
    for (const bin of ["claude", "droid"]) {
      writeFileSync(join(binDir, bin), fakeAgent, { mode: 0o700 });
      chmodSync(join(binDir, bin), 0o700);
    }
    const user = join(dir, "user.json");
    writeFileSync(user, JSON.stringify({ model: "opus", hooks: { SessionStart: [] } }));
    const output = execFileSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'source "$1"; PATH="$3:$PATH"; hash -r; nc() { return 1; }; claude --settings "$2" hello; droid --settings "$2" hello',
        "bash",
        resolve(root, "src-tauri/src/modules/pty/scripts/bashrc.bash"),
        user,
        binDir,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TUNARA_SESSION_ID: "session-1",
          TUNARA_HOOKS_SOCK: "",
          TUNARA_AGENT_CONFIG_DIR: configDir,
        },
      },
    );
    const claude = output.slice(output.indexOf("CALL:claude"), output.indexOf("CALL:droid"));
    const droid = output.slice(output.indexOf("CALL:droid"));
    assert.match(claude, /PLUGIN:ok/);
    assert.match(claude, /SETTINGS:.*"model":"opus"/);
    assert.match(claude, /SETTINGS_COUNT:1/);
    assert.match(droid, /SETTINGS:.*"model":"opus".*"SessionStart"/);
    assert.match(droid, /"UserPromptSubmit"/);
    assert.match(droid, /SETTINGS_COUNT:1/);
    assert.match(droid, /ARG:hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fish shell integration emits cwd, command, and agent lifecycle events", () => {
  const fish = read("src-tauri/src/modules/pty/scripts/config.fish");
  const rust = read("src-tauri/src/modules/pty/shell_init.rs");

  assert.match(fish, /function _tunara_precmd --on-event fish_prompt/);
  assert.match(fish, /function _tunara_preexec --on-event fish_preexec/);
  assert.match(fish, /string escape --style=url/);
  assert.match(fish, /printf '\\e\]7;file:\/\/localhost%s\\e\\\\'/);
  assert.match(fish, /printf '\\e\]133;C;%s\\e\\\\'/);
  assert.match(fish, /printf '\\e\]777;tunara-agent;%s;%s;%s;%s\\e\\\\'/);
  assert.match(fish, /function claude[\s\S]*_tunara_agent_run claude CC/);
  assert.match(fish, /function codex[\s\S]*_tunara_agent_plain_run codex CX/);
  assert.match(fish, /TUNARA_AGENT_CONFIG_DIR/);
  assert.match(fish, /mktemp -d "\$config_dir\/tunara-agent-\$sid\.XXXXXX"/);
  assert.match(fish, /chmod 700 "\$runtime"/);
  assert.match(fish, /set -l helper "\$config_dir\/agent-hook\.sh"/);
  assert.match(fish, /set -l helper_command/);
  assert.match(fish, /\$helper_command idle \$agent \$sid/);
  assert.match(fish, /\$helper_command busy \$agent \$sid/);
  assert.match(fish, /"UserPromptSubmit":\[\{"hooks"/);
  assert.match(fish, /"StopFailure":\[\{"hooks"/);
  assert.match(fish, /command \$real_bin --plugin-dir \$runtime \$argv/);
  assert.match(fish, /merge-settings "\$user_settings" "\$settings" "\$merged"/);
  assert.doesNotMatch(fish, /"command":"printf/);
  assert.doesNotMatch(fish, /\/tmp\/tunara-agent/);

  assert.match(rust, /const FISH_CONFIG: &str = include_str!\("scripts\/config\.fish"\);/);
  assert.match(rust, /Fish,/);
  assert.match(rust, /"fish" => Shell::Fish/);
  assert.match(rust, /Shell::Fish => (?:match prepare_fish_config\(\)|\{[\s\S]*prepare_fish_config\(\))/);
  assert.match(rust, /cmd\.arg\("-C"\);[\s\S]*format!\("source \{\}", fish_quote_path\(&config\)\)/);
  assert.match(rust, /fn prepare_fish_config\(\) -> Result<PathBuf, String>/);
  assert.match(rust, /TUNARA_AGENT_CONFIG_DIR/);
  assert.match(rust, /Path::new\(sp\)\.parent\(\)/);
});

test("remote SSH integration emits per-turn lifecycle hooks without a host socket", () => {
  const remote = read("src-tauri/src/modules/ssh/scripts/remote-integration.sh");

  assert.match(remote, /_tunara_r_agent_hooks\(\)/);
  assert.match(remote, /SessionStart[\s\S]*UserPromptSubmit[\s\S]*Stop[\s\S]*StopFailure[\s\S]*idle_prompt/);
  assert.match(remote, /sh \$\{helper\} busy \$\{agent\} \$\{sid\}/);
  assert.match(remote, /__TUNARA_AGENT_HOOK_B64__/);
  assert.match(remote, /base64 --decode[\s\S]*base64 -D/);
  assert.match(remote, /command "\$bin" --plugin-dir "\$runtime" "\$@"/);
  assert.match(remote, /merge-settings "\$user_settings" "\$settings" "\$merged"/);
  const connection = read("src-tauri/src/modules/ssh/connection.rs");
  assert.match(connection, /const AGENT_HOOK_HELPER: &str = include_str!\("\.\.\/agent\/scripts\/agent-hook\.sh"\)/);
  assert.match(connection, /replace\("__TUNARA_AGENT_HOOK_B64__", &B64\.encode\(AGENT_HOOK_HELPER\)\)/);
  assert.doesNotMatch(remote, /trap '_tunara_r_preexec' DEBUG/);
  assert.match(remote, /BASH_VERSINFO[\s\S]*PS0=/);
  assert.match(remote, /PS1=.*133;B/);
  assert.match(remote, /133;A;input-fallback/);
  assert.match(remote, /function codex \{ _tunara_r_agent_plain_run codex CX/);
  assert.doesNotMatch(remote, /function codex \{ _tunara_r_agent_run codex CX/);
});

test("rendered remote SSH wrapper preserves Claude and Droid user settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "tunara-remote-wrapper-"));
  try {
    const script = join(dir, "remote-integration.sh");
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const rendered = read("src-tauri/src/modules/ssh/scripts/remote-integration.sh")
      .replaceAll("__TUNARA_SESSION_ID__", "remote-session")
      .replaceAll(
        "__TUNARA_AGENT_HOOK_B64__",
        Buffer.from(read("src-tauri/src/modules/agent/scripts/agent-hook.sh")).toString("base64"),
      );
    writeFileSync(script, rendered, { mode: 0o600 });
    const fakeAgent = `#!/bin/sh
printf 'CALL:%s\\n' "\${0##*/}"
settings_count=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plugin-dir)
      [ -f "$2/.claude-plugin/plugin.json" ] && [ -f "$2/hooks/hooks.json" ] && printf 'PLUGIN:ok\\n'
      shift 2
      ;;
    --settings)
      settings_count=$((settings_count + 1))
      printf 'SETTINGS:%s\\n' "$(cat "$2")"
      shift 2
      ;;
    *) printf 'ARG:%s\\n' "$1"; shift ;;
  esac
done
printf 'SETTINGS_COUNT:%s\\n' "$settings_count"
`;
    for (const bin of ["claude", "droid"]) {
      writeFileSync(join(binDir, bin), fakeAgent, { mode: 0o700 });
      chmodSync(join(binDir, bin), 0o700);
    }
    const user = join(dir, "user.json");
    writeFileSync(user, JSON.stringify({ model: "opus", hooks: { SessionStart: [] } }));
    const output = execFileSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'PATH="$3:$PATH"; source "$1" >/dev/null; claude --settings "$2" hello; droid --settings "$2" hello',
        "bash",
        script,
        user,
        binDir,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
    );
    const claude = output.slice(output.indexOf("CALL:claude"), output.indexOf("CALL:droid"));
    const droid = output.slice(output.indexOf("CALL:droid"));
    assert.match(claude, /PLUGIN:ok/);
    assert.match(claude, /SETTINGS_COUNT:1/);
    assert.match(droid, /SETTINGS:.*"model":"opus".*"SessionStart"/);
    assert.match(droid, /"UserPromptSubmit"/);
    assert.match(droid, /SETTINGS_COUNT:1/);
    assert.match(droid, /ARG:hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote Bash prompt integration installs OSC 133 B exactly once", () => {
  if (process.platform === "win32") return;
  const script = resolve(root, "src-tauri/src/modules/ssh/scripts/remote-integration.sh");
  const output = execFileSync("bash", [
    "--noprofile",
    "--norc",
    "-c",
    'PS1=x; source "$1" >/dev/null; _tunara_r_prompt >/dev/null; before=${#PS1}; _tunara_r_prompt >/dev/null; printf "%s %s" "$before" "${#PS1}"',
    "bash",
    script,
  ], { encoding: "utf8" });
  const [before, after] = output.trim().split(/\s+/).map(Number);
  assert.equal(after, before);
});

test("agent hook runtime files avoid predictable shared tmp paths", () => {
  const hooks = read("src-tauri/src/modules/agent/hooks.rs");
  const wrapper = read("src-tauri/src/modules/agent/wrapper.rs");
  const pty = read("src-tauri/src/modules/pty/mod.rs");
  const ssh = read("src-tauri/src/modules/ssh/mod.rs");

  assert.match(hooks, /fn hooks_runtime_dir\(\) -> Result<PathBuf, String>/);
  assert.match(hooks, /XDG_RUNTIME_DIR/);
  assert.match(hooks, /\.join\("\.cache"\)[\s\S]*\.join\("tunara"\)[\s\S]*\.join\("runtime"\)/);
  assert.match(hooks, /fn ensure_private_dir\(path: &Path\) -> Result<\(\), String>/);
  assert.match(hooks, /fs::set_permissions\(path, fs::Permissions::from_mode\(0o700\)\)/);
  assert.match(hooks, /fs::symlink_metadata\(path\)/);
  assert.match(hooks, /file_type\(\)\.is_symlink\(\)/);
  assert.match(hooks, /pub fn agent_config_dir\(&self\) -> Option<&Path>/);
  assert.match(hooks, /use std::os::unix::fs::\{FileTypeExt, PermissionsExt\}/);
  assert.match(hooks, /prune_stale_hook_sockets\(&sock_dir\)/);
  assert.match(hooks, /pub\(super\) fn prune_stale_hook_sockets\(sock_dir: &Path\)/);
  assert.match(hooks, /name\.starts_with\("hooks-"\) \|\| !name\.ends_with\("\.sock"\)/);
  assert.match(hooks, /if !file_type\.is_socket\(\)/);
  assert.match(hooks, /if UnixStream::connect\(&path\)\.is_err\(\)/);
  assert.match(hooks, /let _ = fs::remove_file\(&sock_path_t\)/);
  assert.doesNotMatch(hooks, /std::env::temp_dir\(\)\.join\("tunara-sockets"\)/);

  assert.match(wrapper, /pub fn cleanup_hooks_settings\(session_id: &str, config_dir: Option<&Path>\)/);
  assert.match(wrapper, /let prefix = format!\("tunara-agent-\{session_id\}\."\)/);
  assert.match(wrapper, /symlink_metadata\(&path\)/);
  assert.match(wrapper, /metadata\.file_type\(\)\.is_symlink\(\)/);
  assert.match(wrapper, /metadata\.is_file\(\) && name\.ends_with\("\.json"\)/);
  assert.match(wrapper, /remove_dir_all\(path\)/);
  assert.doesNotMatch(wrapper, /\/tmp\/tunara-agent/);

  assert.match(pty, /hooks_state: tauri::State<HookListenerState>[\s\S]*id: u32/);
  assert.match(pty, /wrapper::cleanup_hooks_settings\(lid, hooks_state\.agent_config_dir\(\)\)/);
  assert.match(pty, /state\.remove_logical\(logical_id\);[\s\S]*wrapper::cleanup_hooks_settings\(logical_id, hooks_state\.agent_config_dir\(\)\)/);
  assert.match(ssh, /hooks_state: tauri::State<'_, HookListenerState>/);
  assert.doesNotMatch(ssh, /state\.remove_logical\(logical_id\)/);
  assert.match(ssh, /SshSession::open\(params, on_event\)[\s\S]*state\.insert\([\s\S]*wrapper::cleanup_hooks_settings\(logical_id, hooks_state\.agent_config_dir\(\)\)/);
});

test("agent lifecycle policy preserves prompt state for Codex and Pi", () => {
  const policy = read("src/modules/terminal/lib/agent-lifecycle.ts");
  const tracker = read("src/modules/terminal/lib/terminal-prompt-agent-state.ts");
  const utils = read("src/modules/terminal/lib/terminal-utils.ts");

  assert.match(policy, /export const HOOK_READY_AGENTS = new Set<AgentCode>\(\["CC", "DR"\]\);/);
  assert.match(policy, /export const PROMPT_READY_AGENTS = new Set<AgentCode>\(\["CX", "PI"\]\);/);
  assert.match(policy, /export function detectAgentCommand\(commandLine: string\): AgentCode \| null/);
  assert.match(policy, /export function isAgentShellTitle\(title: string\): boolean/);
  assert.match(policy, /export function initialAgentActivity\(agent: AgentCode\): AgentActivity/);
  assert.match(policy, /HOOK_READY_AGENTS\.has\(agent\) \|\| PROMPT_READY_AGENTS\.has\(agent\)/);
  assert.match(policy, /export function shouldUseStartupQuietReadyFallback\(/);
  assert.match(policy, /HOOK_READY_AGENTS\.has\(agent\)[\s\S]*activity === "starting"/);
  assert.doesNotMatch(policy, /startupPending/);
  assert.match(policy, /export function isSessionBusy\(session: Session\): boolean/);
  assert.match(policy, /session\.agent[\s\S]*isAgentActivityBusy\(session\.agentActivity\)[\s\S]*session\.runState === "running"/);
  assert.match(policy, /export function hasCompletedAgentTurn\(session: Session\): boolean/);
  assert.match(policy, /export function sessionDisplayRunState\(session: Session\): RunState/);
  assert.match(policy, /export function detectCodexScreenState\(text: string\): AgentScreenState/);
  assert.match(policy, /cleanTerminalLines\(text\)[\s\S]*\.split\("\\n"\)/);
  assert.match(policy, /export const CODEX_BUSY_INDICATORS = \[/);
  assert.match(policy, /\\bWorking\\b/);
  assert.match(policy, /Pursuing goal/);
  assert.match(policy, /background terminal running/);
  assert.match(policy, /export const PROMPT_AGENT_SCREEN_STATE_RECENT_LINE_LIMIT = 12;/);
  assert.match(policy, /lines\.slice\(-PROMPT_AGENT_SCREEN_STATE_RECENT_LINE_LIMIT\)/);
  assert.match(policy, /return CODEX_BUSY_INDICATORS\.some\(\(pattern\) => pattern\.test\(text\)\);/);
  assert.match(policy, /const currentTurnText = recent\.slice\(promptIndex \+ 1\)\.join\("\\n"\);/);
  assert.match(policy, /return hasCodexBusyIndicator\(currentTurnText\) \? "busy" : "ready";/);
  assert.match(policy, /new Set\(\["tunara-agent", "conduit-agent"\]\)/);
  assert.match(policy, /export function parseAgentLifecycleOsc\(data: string\): AgentLifecycleEvent \| null/);
  assert.match(policy, /export function detectPiScreenState\(text: string\): AgentScreenState/);
  assert.match(policy, /PI_BUSY_PATTERN\.test\(recent\)[\s\S]*return "busy"/);
  assert.match(policy, /PI_READY_STATUS_PATTERN\.test\(recent\)[\s\S]*return "ready"/);
  assert.match(policy, /export function detectPromptAgentScreenState\(agent: AgentCode, text: string\)/);
  assert.match(tracker, /export const PROMPT_AGENT_STATE_CHECK_DELAY_MS = 500;/);
  assert.match(tracker, /getTerminalTailText\(terminal, PROMPT_AGENT_SCREEN_STATE_RECENT_LINE_LIMIT\)/);
  assert.match(tracker, /const screenState = detectPromptAgentScreenState\(current\.agent, tail\);/);
  assert.match(tracker, /screenState === "busy"[\s\S]*current\.agentActivity === "idle"[\s\S]*onBusy\(getSessionId\(\)\)/);
  assert.doesNotMatch(tracker, /dataBurstCount|BURST_BUSY_THRESHOLD/);
  assert.match(utils, /export function cleanTerminalLines\(text: string\): string/);
});

test("session store separates identity, busy state, exit, and cwd refresh", () => {
  const types = read("src/ui/types.ts");
  const source = read("src/state/sessions.ts");
  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");

  assert.match(types, /export type AgentActivity = "starting" \| "idle" \| "running";/);
  assert.match(types, /agentActivity\?: AgentActivity;/);
  assert.match(types, /export interface AgentResumeIntent/);
  assert.match(types, /agentResume\?: AgentResumeIntent;/);
  assert.match(types, /suppressShellTitle\?: boolean;/);
  assert.match(types, /export function isPromptLikeShellTitle\(title: string\): boolean/);
  assert.match(types, /const lastCommand = s\.lastCommand && !isPromptLikeShellTitle\(s\.lastCommand\)/);
  // Agent sessions show "name · activity"; the bare name when idle. Activity is
  // derived from agentActivity (Claude Code's OSC title is just its own name).
  assert.match(types, /export function agentActivityLabel\(activity\?: AgentActivity\): string \| undefined/);
  assert.match(types, /const hasMeaningfulShellTitle =[\s\S]*&& !s\.suppressShellTitle[\s\S]*&& !isPromptLikeShellTitle\(s\.shellTitle\)[\s\S]*&& s\.shellTitle !== shortDir\(s\.dir\);/);
  assert.match(types, /const status = agentActivityLabel\(s\.agentActivity\);[\s\S]*primary = status \? `\$\{name\} · \$\{status\}` : name;/);
  assert.match(types, /primary = s\.title && !isPromptLikeShellTitle\(s\.title\) \? s\.title : t\("session\.default_title"\);/);
  assert.match(source, /agentActivity: opts\?\.agent \? initialAgentActivity\(opts\.agent\) : undefined,/);
  assert.match(source, /agentDetectedUpdate\(session, agent\)/);
  assert.match(source, /function buildAgentResumeIntent/);
  assert.match(source, /handleAgentDetected: \(id, agent, command\)/);
  assert.match(source, /agentResume: buildAgentResumeIntent|const agentResume = buildAgentResumeIntent/);
  assert.match(source, /agentReadyUpdate\(session, isActive\)/);
  assert.match(source, /agentBusyUpdate\(session\)/);
  assert.match(source, /agentExitedUpdate\(session, exitCode, isActive\)/);
  assert.match(source, /commandDetectedUpdate\(session, command\)/);
  assert.match(source, /commandFinishedUpdate\(session, exitCode, isActive\)/);
  assert.match(source, /terminalExitedUpdate\(session, exitCode, isSessionObserved\(get\(\)\.activeSessionId, id\)\)/);
  assert.match(source, /cwdChangedUpdate\(session, cwd\)/);
  assert.match(source, /shellTitleUpdate\(session, title\)/);
  assert.match(source, /if \(update\.refreshGit\) get\(\)\.refreshGit\(id\);/);
  assert.match(lifecycle, /export function agentDetectedUpdate\([\s\S]*?if \(!session \|\| session\.agent === agent\) return null;[\s\S]*?agentActivity: initialAgentActivity\(agent\),[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentReadyUpdate\([\s\S]*?session\.agentActivity === "idle"\) return null;[\s\S]*?agentActivity: "idle",[\s\S]*?runState: "idle",[\s\S]*?completedTurn \? \{ refreshGit: true \} : \{\}/);
  assert.match(lifecycle, /export function agentBusyUpdate\([\s\S]*?agentActivity: "running",[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentExitedUpdate\([\s\S]*?agent: undefined,[\s\S]*?agentActivity: undefined,[\s\S]*?title: t\("session\.default_title"\),[\s\S]*?suppressShellTitle: true,[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function commandDetectedUpdate\([\s\S]*?session\?\.agent \|\| isPromptLikeShellTitle\(command\)[\s\S]*?suppressShellTitle: false,/);
  assert.match(lifecycle, /export function commandFinishedUpdate\([\s\S]*?if \(session\.agent \|\| !session\.lastCommand\)[\s\S]*?runState: exitCode === 0 \? "done" : "failed",/);
  assert.match(lifecycle, /export function terminalExitedUpdate\([\s\S]*?agent: undefined,[\s\S]*?agentActivity: undefined,[\s\S]*?runState: exitCode === 0 \? "done" : "failed",[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function cwdChangedUpdate\([\s\S]*?if \(!session \|\| session\.dir === cwd\) return null;[\s\S]*?dir: cwd,[\s\S]*?branch: "",[\s\S]*?changes: undefined,[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /Agent sessions do not get a shellTitle/);
  assert.match(lifecycle, /export function shellTitleUpdate\([\s\S]*?session\?\.agent[\s\S]*?session\?\.suppressShellTitle[\s\S]*?isAgentShellTitle\(title\)[\s\S]*?isPromptLikeShellTitle\(title\)/);
  assert.match(source, /if \(session && isSessionBusy\(session\)\) \{/);
  assert.doesNotMatch(source, /handleAgentTurnDone/);
  assert.doesNotMatch(source, /handleAgentResumed/);
});

test("runtime event consumers call semantic lifecycle transitions", () => {
  const terminal = read("src/ui/TerminalView.tsx");
  const terminalExit = read("src/ui/terminal-exit.ts");
  const listener = read("src/modules/terminal/lib/hooks-listener.ts");
  const zshrc = read("src-tauri/src/modules/pty/scripts/zshrc.zsh");

  assert.match(listener, /if \(event === "start"\) \{[\s\S]*?store\.handleAgentDetected\(session, agent\);/);
  assert.match(listener, /if \(event === "exit"\) \{[\s\S]*?if \(current\?\.agent === agent\) \{[\s\S]*?store\.handleAgentExited\(session, code \?\? 0\);/);
  assert.match(listener, /if \(event === "busy" \|\| event === "stop" \|\| event === "idle"\)/);
  assert.match(listener, /if \(event === "busy"\) store\.handleAgentBusy\(session\);[\s\S]*?else store\.handleAgentReady\(session\);/);
  assert.doesNotMatch(listener, /if \(!current\?\.agent\) store\.handleAgentDetected/);
  assert.match(zshrc, /printf '\\e\]133;C;%s\\e\\\\' "\$\(.*"\$1"\)"/);
  assert.match(terminal, /import \{ detectAgentCommand, parseAgentLifecycleOsc, PROMPT_READY_AGENTS, shouldUseStartupQuietReadyFallback \}/);
  assert.match(terminal, /import \{ createPromptAgentScreenStateTracker \}/);
  assert.match(terminal, /const agentLifecycleDisposable = term\.parser\.registerOscHandler\(777, applyAgentLifecycleEvent\);/);
  assert.doesNotMatch(terminal, /const HOOKABLE_AGENTS/);
  assert.doesNotMatch(terminal, /const PROMPT_DETECTED_AGENTS/);
  assert.doesNotMatch(terminal, /\blet hasAgent\b|\blet currentAgentCode\b|\blet agentStartupPending\b/);
  assert.doesNotMatch(terminal, /useSessionsStore\.subscribe/);
  assert.match(terminal, /const handleCwdChange = \(cwd: string\) => \{[\s\S]*lineCwdTracker\.record\(cwd, term\.registerMarker\(0\)\);[\s\S]*handleCwdChange\(sessionIdRef\.current, cwd\);[\s\S]*\};/);
  assert.match(terminal, /registerCwdHandler\(term, handleCwdChange\)/);
  assert.doesNotMatch(terminal, /registerCwdHandler\(term, \(cwd\) => \{[\s\S]{0,400}handleAgentExited/);
  assert.match(terminal, /const trackedSession = getCurrentSession\(\);[\s\S]*if \(trackedSession\?\.agent\) \{/);
  assert.match(terminal, /if \(PROMPT_READY_AGENTS\.has\(current\.agent\)\) \{[\s\S]*?promptAgentStateTracker\.schedule\(\);[\s\S]*?return;/);
  assert.match(terminal, /createPromptAgentScreenStateTracker\(\{/);
  assert.match(terminal, /promptAgentStateTracker\.schedule\(\);/);
  assert.doesNotMatch(terminal, /codexDataBurstCount/);
  assert.match(terminal, /shouldUseStartupQuietReadyFallback\(current\.agent, current\.agentActivity\)[\s\S]*scheduleStartupQuietReady\(\);/);
  assert.doesNotMatch(terminal, /sess\?\.agentActivity === "running"[\s\S]{0,120}scheduleStartupQuietReady/);
  assert.match(terminal, /const submitAgentInput = \(submitted: string\) => \{[\s\S]*const trimmed = cleanTerminalText\(submitted\)\.trim\(\);[\s\S]*if \(!trimmed\) return;[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /scanTerminalInputBuffer\(inputBuffer, data\)[\s\S]*for \(const submitted of result\.submissions\) \{[\s\S]*submitAgentInput\(submitted\);[\s\S]*submitCommandBuffer\(submitted\);/);
  assert.match(terminal, /const oscCommand = extractCommandFromOsc\(data\);[\s\S]*promptEndRow >= 0 \|\| oscCommand/);
  assert.match(terminal, /if \(!currentAgent\) \{[\s\S]*const agent = detectAgentCommand\(submitted\);/);
  assert.match(terminal, /handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentReady\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentExited\(sessionIdRef\.current, exitCode\)/);
  assert.match(terminal, /onExit: \(code: number\) => \{[\s\S]*?if \(disposed\) return;[\s\S]*?handleTerminalProcessExit\(term, sessionIdRef\.current, code, Boolean\(getCurrentSession\(\)\?\.remote\)\);[\s\S]*?\}/);
  assert.match(terminalExit, /remote && code === SSH_DISCONNECTED_EXIT_CODE[\s\S]*?terminal\.inline\.disconnected[\s\S]*?terminal\.inline\.exited/);
  assert.match(terminalExit, /term\.write\(`\\r\\n\\x1b\[2m\$\{message\}\\x1b\[0m\\r\\n`\);/);
  assert.match(terminalExit, /term\.options\.disableStdin = true;/);
  assert.match(terminalExit, /handleTerminalExited\(sessionId, code\);/);
});

test("UI renders sidebar progress only when an agent is busy", () => {
  const card = read("src/ui/SessionCard.tsx");
  const status = read("src/ui/AgentStatusBar.tsx");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");

  assert.match(card, /import \{ isSessionBusy, sessionDisplayRunState \}/);
  assert.match(card, /const displayRunState = sessionDisplayRunState\(session\);/);
  assert.match(card, /const busy = isSessionBusy\(session\);/);
  assert.match(card, /const showTerminalProgress = !!session\.terminalProgress;/);
  assert.match(card, /const showBusyProgress = !!session\.agent && busy && !showTerminalProgress;/);
  assert.match(card, /function TerminalProgressBar/);
  assert.match(card, /session\.terminalProgress && <TerminalProgressBar/);
  assert.match(card, /showBusyProgress && <BusyProgress \/>/);
  assert.match(card, /animation: "agentBusyProgress/);
  assert.doesNotMatch(card, /const showBusyProgress = session\.runState === "running";/);
  assert.match(status, /import \{ hasCompletedAgentTurn, isAgentActivityBusy \}/);
  assert.match(status, /const isBusy = !!session\.agent && isAgentActivityBusy\(session\.agentActivity\);/);
  assert.match(status, /session\.agent && session\.agentActivity === "idle" && !hasCompletedAgentTurn\(session\)/);
  assert.match(main, /<AgentStatusBar session=/);
  assert.doesNotMatch(diff, /session\.runState !== "running"/);
});
