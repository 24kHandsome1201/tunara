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
    assert.match(script, /if \[\[? -n "\$CONDUIT_SESSION_ID"/);
    assert.match(script, /_conduit_agent_osc\(\)/);
    assert.match(script, /printf '\\e\]777;conduit-agent;%s;%s;%s;%s\\e\\\\'/);
    assert.match(script, /_conduit_agent_emit start "\$agent"/);
    assert.match(script, /_conduit_agent_emit exit "\$agent" "\$ret"/);
    assert.match(script, /CONDUIT_HOOKS_SOCK[\s\S]*return 0/);
    assert.match(script, /if \[\[? -n "\$sock"/);
    assert.match(script, /command "\$real_bin" --settings "\$f" "\$@"/);
    assert.match(script, /else[\s\S]*command "\$real_bin" "\$@"/);
    assert.match(script, /claude\(\) \{ _conduit_agent_run claude CC/);
    assert.match(script, /droid\(\) \{ _conduit_agent_run droid DR/);
    assert.match(script, /codex\(\) \{ _conduit_agent_plain_run codex CX/);
    assert.doesNotMatch(script, /\bcodex\(\) \{ _conduit_agent_run codex/);
    assert.doesNotMatch(script, /\bdevin\(\) \{ _conduit_agent_run devin/);
    assert.match(script, /"SessionStart":\[\{"matcher":"startup\|resume"/);
    assert.match(script, /\\"event\\":\\"idle\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
    assert.match(script, /\\"event\\":\\"stop\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
  }
});

test("fish shell integration emits cwd, command, and agent lifecycle events", () => {
  const fish = read("src-tauri/src/modules/pty/scripts/config.fish");
  const rust = read("src-tauri/src/modules/pty/shell_init.rs");

  assert.match(fish, /function _conduit_precmd --on-event fish_prompt/);
  assert.match(fish, /function _conduit_preexec --on-event fish_preexec/);
  assert.match(fish, /string escape --style=url/);
  assert.match(fish, /printf '\\e\]7;file:\/\/localhost%s\\e\\\\'/);
  assert.match(fish, /printf '\\e\]133;C;%s\\e\\\\'/);
  assert.match(fish, /printf '\\e\]777;conduit-agent;%s;%s;%s;%s\\e\\\\'/);
  assert.match(fish, /function claude[\s\S]*_conduit_agent_run claude CC/);
  assert.match(fish, /function codex[\s\S]*_conduit_agent_plain_run codex CX/);

  assert.match(rust, /const FISH_CONFIG: &str = include_str!\("scripts\/config\.fish"\);/);
  assert.match(rust, /Fish,/);
  assert.match(rust, /"fish" => Shell::Fish/);
  assert.match(rust, /Shell::Fish => \{[\s\S]*cmd\.arg\("-C"\);[\s\S]*source \{\}/);
  assert.match(rust, /fn prepare_fish_config\(\) -> Result<PathBuf, String>/);
});

test("agent lifecycle policy preserves line structure for Codex", () => {
  const policy = read("src/modules/terminal/lib/agent-lifecycle.ts");
  const utils = read("src/modules/terminal/lib/terminal-utils.ts");

  assert.match(policy, /export const HOOK_READY_AGENTS = new Set<AgentCode>\(\["CC", "DR"\]\);/);
  assert.match(policy, /export const PROMPT_READY_AGENTS = new Set<AgentCode>\(\["CX"\]\);/);
  assert.match(policy, /export function detectAgentCommand\(commandLine: string\): AgentCode \| null/);
  assert.match(policy, /export function isAgentShellTitle\(title: string\): boolean/);
  assert.match(policy, /export function initialAgentActivity\(agent: AgentCode\): AgentActivity/);
  assert.match(policy, /if \(HOOK_READY_AGENTS\.has\(agent\)\) return "starting";/);
  assert.match(policy, /if \(PROMPT_READY_AGENTS\.has\(agent\)\) return "idle";/);
  assert.match(policy, /export function isSessionBusy\(session: Session\): boolean/);
  assert.match(policy, /session\.agent[\s\S]*isAgentActivityBusy\(session\.agentActivity\)[\s\S]*session\.runState === "running"/);
  assert.match(policy, /export function sessionDisplayRunState\(session: Session\): RunState/);
  assert.match(policy, /export function detectCodexScreenState\(text: string\): AgentScreenState/);
  assert.match(policy, /cleanTerminalLines\(text\)[\s\S]*\.split\("\\n"\)/);
  assert.match(policy, /function hasCodexBusyIndicator\(text: string\): boolean \{[\s\S]*\\bWorking\\b[\s\S]*Pursuing goal[\s\S]*background terminal running/);
  assert.match(policy, /return hasCodexBusyIndicator\(recentJoined\) \? "busy" : "ready";/);
  assert.match(policy, /export function parseAgentLifecycleOsc\(data: string\): AgentLifecycleEvent \| null/);
  assert.match(utils, /export function cleanTerminalLines\(text: string\): string/);
});

test("session store separates identity, busy state, exit, and cwd refresh", () => {
  const types = read("src/ui/types.ts");
  const source = read("src/state/sessions.ts");
  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");

  assert.match(types, /export type AgentActivity = "starting" \| "idle" \| "running";/);
  assert.match(types, /agentActivity\?: AgentActivity;/);
  assert.match(types, /suppressShellTitle\?: boolean;/);
  assert.match(types, /export function isPromptLikeShellTitle\(title: string\): boolean/);
  assert.match(types, /const lastCommand = s\.lastCommand && !isPromptLikeShellTitle\(s\.lastCommand\)/);
  assert.match(types, /&& !s\.suppressShellTitle[\s\S]*&& !isPromptLikeShellTitle\(s\.shellTitle\)/);
  assert.match(types, /primary = s\.title && !isPromptLikeShellTitle\(s\.title\) \? s\.title : "终端";/);
  assert.match(source, /agentActivity: opts\?\.agent \? initialAgentActivity\(opts\.agent\) : undefined,/);
  assert.match(source, /agentDetectedUpdate\(session, agent\)/);
  assert.match(source, /agentReadyUpdate\(session, isActive\)/);
  assert.match(source, /agentBusyUpdate\(session\)/);
  assert.match(source, /agentExitedUpdate\(session, exitCode, isActive\)/);
  assert.match(source, /commandDetectedUpdate\(session, command\)/);
  assert.match(source, /commandFinishedUpdate\(session, exitCode, isActive\)/);
  assert.match(source, /cwdChangedUpdate\(session, cwd\)/);
  assert.match(source, /shellTitleUpdate\(session, title\)/);
  assert.match(source, /if \(update\.refreshGit\) get\(\)\.refreshGit\(id\);/);
  assert.match(lifecycle, /export function agentDetectedUpdate\([\s\S]*?if \(!session \|\| session\.agent === agent\) return null;[\s\S]*?agentActivity: initialAgentActivity\(agent\),[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentReadyUpdate\([\s\S]*?agentActivity: "idle",[\s\S]*?runState: "idle",[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function agentBusyUpdate\([\s\S]*?agentActivity: "running",[\s\S]*?runState: "idle",/);
  assert.match(lifecycle, /export function agentExitedUpdate\([\s\S]*?agent: undefined,[\s\S]*?agentActivity: undefined,[\s\S]*?title: "终端",[\s\S]*?suppressShellTitle: true,[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function commandDetectedUpdate\([\s\S]*?session\?\.agent \|\| isPromptLikeShellTitle\(command\)[\s\S]*?suppressShellTitle: false,/);
  assert.match(lifecycle, /export function commandFinishedUpdate\([\s\S]*?if \(session\.agent \|\| !session\.lastCommand\)[\s\S]*?runState: exitCode === 0 \? "done" : "failed",/);
  assert.match(lifecycle, /export function cwdChangedUpdate\([\s\S]*?if \(!session \|\| session\.dir === cwd\) return null;[\s\S]*?dir: cwd,[\s\S]*?branch: "",[\s\S]*?changes: undefined,[\s\S]*?refreshGit: true,/);
  assert.match(lifecycle, /export function shellTitleUpdate\([\s\S]*?session\?\.agent[\s\S]*?session\?\.suppressShellTitle[\s\S]*?isAgentShellTitle\(title\)[\s\S]*?isPromptLikeShellTitle\(title\)/);
  assert.match(source, /if \(session && isSessionBusy\(session\)\) \{/);
  assert.doesNotMatch(source, /handleAgentTurnDone/);
  assert.doesNotMatch(source, /handleAgentResumed/);
});

test("runtime event consumers call semantic lifecycle transitions", () => {
  const terminal = read("src/ui/TerminalView.tsx");
  const listener = read("src/modules/terminal/lib/hooks-listener.ts");
  const zshrc = read("src-tauri/src/modules/pty/scripts/zshrc.zsh");

  assert.match(listener, /if \(event === "start" && agent\) \{[\s\S]*?store\.handleAgentDetected\(session, agent\);/);
  assert.match(listener, /if \(event === "exit"\) \{[\s\S]*?if \(current\?\.agent && \(!agent \|\| current\.agent === agent\)\) \{[\s\S]*?store\.handleAgentExited\(session, code \?\? 0\);/);
  assert.match(listener, /if \(\(event === "stop" \|\| event === "idle"\) && agent\) \{[\s\S]*?if \(current\?\.agent === agent\) \{[\s\S]*?store\.handleAgentReady\(session\);/);
  assert.doesNotMatch(listener, /if \(!current\?\.agent\) store\.handleAgentDetected/);
  assert.match(zshrc, /printf '\\e\]133;C;%s\\e\\\\' "\$\(.*"\$1"\)"/);
  assert.match(terminal, /import \{ detectAgentCommand, detectCodexScreenState, HOOK_READY_AGENTS, parseAgentLifecycleOsc, PROMPT_READY_AGENTS \}/);
  assert.match(terminal, /const agentLifecycleDisposable = term\.parser\.registerOscHandler\(777, applyAgentLifecycleEvent\);/);
  assert.doesNotMatch(terminal, /const HOOKABLE_AGENTS/);
  assert.doesNotMatch(terminal, /const PROMPT_DETECTED_AGENTS/);
  assert.match(terminal, /agentStartupPending = sess\?\.agent === agent[\s\S]*HOOK_READY_AGENTS\.has\(agent\);/);
  assert.match(terminal, /const syncAgentTrackingFromStore = \(\) => \{[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /useSessionsStore\.subscribe[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /registerCwdHandler\(term, \(cwd\) => \{[\s\S]*handleCwdChange\(sessionIdRef\.current, cwd\);[\s\S]*\}\),/);
  assert.doesNotMatch(terminal, /registerCwdHandler\(term, \(cwd\) => \{[\s\S]{0,400}handleAgentExited/);
  assert.match(terminal, /const trackedSession = syncAgentTrackingFromStore\(\);[\s\S]*if \(hasAgent \|\| trackedSession\?\.agent\) \{/);
  assert.match(terminal, /if \(PROMPT_READY_AGENTS\.has\(currentAgentCode\)\) \{[\s\S]*?scheduleCodexStateCheck\(\);[\s\S]*?return;/);
  assert.match(terminal, /codexDataBurstCount[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /const screenState = detectCodexScreenState\(tail\);[\s\S]*if \(screenState === "ready"[\s\S]*handleAgentReady\(sessionIdRef\.current\)/);
  assert.match(terminal, /const submitAgentInput = \(submitted: string\) => \{[\s\S]*const trimmed = cleanTerminalText\(submitted\)\.trim\(\);[\s\S]*if \(!trimmed\) return;[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /scanTerminalInputBuffer\(inputBuffer, data\)[\s\S]*for \(const submitted of result\.submissions\) \{[\s\S]*submitAgentInput\(submitted\);[\s\S]*submitCommandBuffer\(submitted\);/);
  assert.match(terminal, /const oscCommand = extractCommandFromOsc\(data\);[\s\S]*promptEndRow >= 0 \|\| oscCommand/);
  assert.match(terminal, /if \(!hasAgent\) \{[\s\S]*const agent = detectAgentCommand\(submitted\);/);
  assert.match(terminal, /handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentReady\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentExited\(sessionIdRef\.current, exitCode\)/);
});

test("UI renders sidebar progress only when an agent is busy", () => {
  const card = read("src/ui/SessionCard.tsx");
  const status = read("src/ui/AgentStatusBar.tsx");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");

  assert.match(card, /import \{ isSessionBusy, sessionDisplayRunState \}/);
  assert.match(card, /const displayRunState = sessionDisplayRunState\(session\);/);
  assert.match(card, /const busy = isSessionBusy\(session\);/);
  assert.match(card, /const showBusyProgress = !!session\.agent && busy;/);
  assert.match(card, /showBusyProgress && <BusyProgress \/>/);
  assert.match(card, /animation: "agentBusyProgress/);
  assert.doesNotMatch(card, /const showBusyProgress = session\.runState === "running";/);
  assert.doesNotMatch(card, /animation: "indeterminate/);
  assert.match(status, /import \{ isAgentActivityBusy \}/);
  assert.match(status, /const isBusy = !!session\.agent && isAgentActivityBusy\(session\.agentActivity\);/);
  assert.match(main, /isAgentActivityBusy\(active\.agentActivity\)/);
  assert.match(diff, /const busy = isSessionBusy\(session\);/);
  assert.doesNotMatch(diff, /session\.runState !== "running"/);
});
