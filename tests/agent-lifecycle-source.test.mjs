import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    assert.match(script, /if \[\[? -n "\$sock"/);
    assert.match(script, /TUNARA_AGENT_CONFIG_DIR/);
    assert.match(script, /mktemp "\$config_dir\/tunara-agent-\$\{sid\}\.XXXXXX\.json"/);
    assert.match(script, /chmod 600 "\$f"/);
    assert.match(script, /nc -U \\"\\\$TUNARA_HOOKS_SOCK\\"/);
    assert.doesNotMatch(script, /\/tmp\/tunara-agent/);
    assert.match(script, /command "\$real_bin" --settings "\$f" "\$@"/);
    assert.match(script, /else[\s\S]*command "\$real_bin" "\$@"/);
    assert.match(script, /claude\(\) \{ _tunara_agent_run claude CC/);
    assert.match(script, /droid\(\) \{ _tunara_agent_run droid DR/);
    assert.match(script, /codex\(\) \{ _tunara_agent_plain_run codex CX/);
    assert.doesNotMatch(script, /\bcodex\(\) \{ _tunara_agent_run codex/);
    assert.doesNotMatch(script, /\bdevin\(\) \{ _tunara_agent_run devin/);
    assert.match(script, /"SessionStart":\[\{"matcher":"startup\|resume"/);
    assert.match(script, /\\"event\\":\\"idle\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
    assert.match(script, /\\"event\\":\\"stop\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
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
  assert.match(fish, /mktemp "\$config_dir\/tunara-agent-\$sid\.XXXXXX\.json"/);
  assert.match(fish, /chmod 600 "\$f"/);
  assert.match(fish, /nc -U \\\\"\$TUNARA_HOOKS_SOCK\\\\"/);
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
  assert.match(wrapper, /name\.starts_with\(&prefix\) && name\.ends_with\("\.json"\)/);
  assert.doesNotMatch(wrapper, /\/tmp\/tunara-agent/);

  assert.match(pty, /hooks_state: tauri::State<HookListenerState>[\s\S]*id: u32/);
  assert.match(pty, /wrapper::cleanup_hooks_settings\(lid, hooks_state\.agent_config_dir\(\)\)/);
  assert.match(pty, /state\.remove_logical\(logical_id\);[\s\S]*wrapper::cleanup_hooks_settings\(logical_id, hooks_state\.agent_config_dir\(\)\)/);
  assert.match(ssh, /hooks_state: tauri::State<'_, HookListenerState>/);
  assert.match(ssh, /state\.remove_logical\(logical_id\);[\s\S]*wrapper::cleanup_hooks_settings\(logical_id, hooks_state\.agent_config_dir\(\)\)/);
});

test("agent lifecycle policy preserves line structure for Codex", () => {
  const policy = read("src/modules/terminal/lib/agent-lifecycle.ts");
  const tracker = read("src/modules/terminal/lib/terminal-codex-state.ts");
  const utils = read("src/modules/terminal/lib/terminal-utils.ts");

  assert.match(policy, /export const HOOK_READY_AGENTS = new Set<AgentCode>\(\["CC", "DR"\]\);/);
  assert.match(policy, /export const PROMPT_READY_AGENTS = new Set<AgentCode>\(\["CX"\]\);/);
  assert.match(policy, /export function detectAgentCommand\(commandLine: string\): AgentCode \| null/);
  assert.match(policy, /export function isAgentShellTitle\(title: string\): boolean/);
  assert.match(policy, /export function initialAgentActivity\(agent: AgentCode\): AgentActivity/);
  assert.match(policy, /if \(HOOK_READY_AGENTS\.has\(agent\)\) return "starting";/);
  assert.match(policy, /if \(PROMPT_READY_AGENTS\.has\(agent\)\) return "idle";/);
  assert.match(policy, /export function shouldUseStartupQuietReadyFallback\(/);
  assert.match(policy, /HOOK_READY_AGENTS\.has\(agent\)[\s\S]*startupPending[\s\S]*activity === "starting"/);
  assert.match(policy, /export function isSessionBusy\(session: Session\): boolean/);
  assert.match(policy, /session\.agent[\s\S]*isAgentActivityBusy\(session\.agentActivity\)[\s\S]*session\.runState === "running"/);
  assert.match(policy, /export function sessionDisplayRunState\(session: Session\): RunState/);
  assert.match(policy, /export function detectCodexScreenState\(text: string\): AgentScreenState/);
  assert.match(policy, /cleanTerminalLines\(text\)[\s\S]*\.split\("\\n"\)/);
  assert.match(policy, /export const CODEX_BUSY_INDICATORS = \[/);
  assert.match(policy, /\\bWorking\\b/);
  assert.match(policy, /Pursuing goal/);
  assert.match(policy, /background terminal running/);
  assert.match(policy, /export const CODEX_SCREEN_STATE_RECENT_LINE_LIMIT = 12;/);
  assert.match(policy, /lines\.slice\(-CODEX_SCREEN_STATE_RECENT_LINE_LIMIT\)/);
  assert.match(policy, /return CODEX_BUSY_INDICATORS\.some\(\(pattern\) => pattern\.test\(text\)\);/);
  assert.match(policy, /const currentTurnText = recent\.slice\(promptIndex \+ 1\)\.join\("\\n"\);/);
  assert.match(policy, /return hasCodexBusyIndicator\(currentTurnText\) \? "busy" : "ready";/);
  assert.match(policy, /new Set\(\["tunara-agent", "conduit-agent"\]\)/);
  assert.match(policy, /export function parseAgentLifecycleOsc\(data: string\): AgentLifecycleEvent \| null/);
  assert.match(tracker, /export const CODEX_DATA_BURST_BUSY_THRESHOLD = 3;/);
  assert.match(tracker, /export const CODEX_STATE_CHECK_DELAY_MS = 500;/);
  assert.match(tracker, /getTerminalTailText\(terminal, CODEX_SCREEN_STATE_RECENT_LINE_LIMIT\)/);
  assert.match(tracker, /const screenState = detectCodexScreenState\(tail\);/);
  assert.match(tracker, /screenState === "busy"[\s\S]*onBusy\(getSessionId\(\)\)/);
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
  assert.match(types, /primary = s\.title && !isPromptLikeShellTitle\(s\.title\) \? s\.title : "终端";/);
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
  assert.match(source, /terminalExitedUpdate\(session, exitCode, get\(\)\.activeSessionId === id\)/);
  assert.match(source, /cwdChangedUpdate\(session, cwd\)/);
  assert.match(source, /shellTitleUpdate\(session, title\)/);
  assert.match(source, /if \(update\.refreshGit\) get\(\)\.refreshGit\(id\);/);
  assert.match(lifecycle, /export function agentDetectedUpdate\([\s\S]*?if \(!session \|\| session\.agent === agent\) return null;[\s\S]*?agentActivity: initialAgentActivity\(agent\),[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentReadyUpdate\([\s\S]*?agentActivity: "idle",[\s\S]*?runState: "idle",[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function agentBusyUpdate\([\s\S]*?agentActivity: "running",[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentExitedUpdate\([\s\S]*?agent: undefined,[\s\S]*?agentActivity: undefined,[\s\S]*?title: "终端",[\s\S]*?suppressShellTitle: true,[\s\S]*?refreshGit: true,/);
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

  assert.match(listener, /if \(event === "start" && agent\) \{[\s\S]*?store\.handleAgentDetected\(session, agent\);/);
  assert.match(listener, /if \(event === "exit"\) \{[\s\S]*?if \(current\?\.agent && \(!agent \|\| current\.agent === agent\)\) \{[\s\S]*?store\.handleAgentExited\(session, code \?\? 0\);/);
  assert.match(listener, /if \(\(event === "stop" \|\| event === "idle"\) && agent\) \{[\s\S]*?if \(current\?\.agent === agent\) \{[\s\S]*?store\.handleAgentReady\(session\);/);
  assert.doesNotMatch(listener, /if \(!current\?\.agent\) store\.handleAgentDetected/);
  assert.match(zshrc, /printf '\\e\]133;C;%s\\e\\\\' "\$\(.*"\$1"\)"/);
  assert.match(terminal, /import \{ detectAgentCommand, HOOK_READY_AGENTS, parseAgentLifecycleOsc, PROMPT_READY_AGENTS, shouldUseStartupQuietReadyFallback \}/);
  assert.match(terminal, /import \{ createCodexScreenStateTracker \}/);
  assert.match(terminal, /const agentLifecycleDisposable = term\.parser\.registerOscHandler\(777, applyAgentLifecycleEvent\);/);
  assert.doesNotMatch(terminal, /const HOOKABLE_AGENTS/);
  assert.doesNotMatch(terminal, /const PROMPT_DETECTED_AGENTS/);
  assert.match(terminal, /agentStartupPending = sess\?\.agent === agent[\s\S]*HOOK_READY_AGENTS\.has\(agent\);/);
  assert.match(terminal, /const syncAgentTrackingFromStore = \(\) => \{[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /useSessionsStore\.subscribe[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /const handleCwdChange = \(cwd: string\) => \{[\s\S]*lineCwdTracker\.record\(cwd, term\.registerMarker\(0\)\);[\s\S]*handleCwdChange\(sessionIdRef\.current, cwd\);[\s\S]*\};/);
  assert.match(terminal, /registerCwdHandler\(term, handleCwdChange\)/);
  assert.doesNotMatch(terminal, /registerCwdHandler\(term, \(cwd\) => \{[\s\S]{0,400}handleAgentExited/);
  assert.match(terminal, /const trackedSession = syncAgentTrackingFromStore\(\);[\s\S]*if \(hasAgent \|\| trackedSession\?\.agent\) \{/);
  assert.match(terminal, /if \(PROMPT_READY_AGENTS\.has\(currentAgentCode\)\) \{[\s\S]*?codexStateTracker\.schedule\(\);[\s\S]*?return;/);
  assert.match(terminal, /createCodexScreenStateTracker\(\{[\s\S]*isTrackingCodex: \(\) => hasAgent && currentAgentCode === "CX"/);
  assert.match(terminal, /codexStateTracker\.schedule\(\);/);
  assert.doesNotMatch(terminal, /codexDataBurstCount/);
  assert.match(terminal, /shouldUseStartupQuietReadyFallback\(currentAgentCode, sess\?\.agentActivity, agentStartupPending\)[\s\S]*scheduleStartupQuietReady\(\);/);
  assert.doesNotMatch(terminal, /sess\?\.agentActivity === "running"[\s\S]{0,120}scheduleStartupQuietReady/);
  assert.match(terminal, /const submitAgentInput = \(submitted: string\) => \{[\s\S]*const trimmed = cleanTerminalText\(submitted\)\.trim\(\);[\s\S]*if \(!trimmed\) return;[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /scanTerminalInputBuffer\(inputBuffer, data\)[\s\S]*for \(const submitted of result\.submissions\) \{[\s\S]*submitAgentInput\(submitted\);[\s\S]*submitCommandBuffer\(submitted\);/);
  assert.match(terminal, /const oscCommand = extractCommandFromOsc\(data\);[\s\S]*promptEndRow >= 0 \|\| oscCommand/);
  assert.match(terminal, /if \(!hasAgent\) \{[\s\S]*const agent = detectAgentCommand\(submitted\);/);
  assert.match(terminal, /handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentReady\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentExited\(sessionIdRef\.current, exitCode\)/);
  assert.match(terminal, /onExit: \(code: number\) => \{[\s\S]*?if \(disposed\) return;[\s\S]*?handleTerminalProcessExit\(term, sessionIdRef\.current, code\);[\s\S]*?\}/);
  assert.match(terminalExit, /term\.write\(`\\r\\n\\x1b\[2m\[process exited: \$\{code\}\]\\x1b\[0m\\r\\n`\);/);
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
  assert.match(status, /import \{ isAgentActivityBusy \}/);
  assert.match(status, /const isBusy = !!session\.agent && isAgentActivityBusy\(session\.agentActivity\);/);
  assert.match(main, /<AgentStatusBar session=/);
  assert.doesNotMatch(diff, /session\.runState !== "running"/);
});
