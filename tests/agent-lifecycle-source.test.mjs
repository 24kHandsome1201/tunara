import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("shell wrappers emit explicit lifecycle events and only inject settings for supported CLIs", () => {
  for (const path of [
    "src-tauri/src/modules/pty/scripts/zshrc.zsh",
    "src-tauri/src/modules/pty/scripts/bashrc.bash",
  ]) {
    const script = read(path);
    assert.match(script, /claude\(\) \{ _conduit_agent_run claude CC/);
    assert.match(script, /droid\(\) \{ _conduit_agent_run droid DR/);
    assert.match(script, /codex\(\) \{ _conduit_agent_plain_run codex CX/);
    assert.doesNotMatch(script, /\bcodex\(\) \{ _conduit_agent_run codex/);
    assert.doesNotMatch(script, /\bdevin\(\) \{ _conduit_agent_run devin/);
    assert.match(script, /_conduit_agent_emit start "\$agent"/);
    assert.match(script, /_conduit_agent_emit exit "\$agent" "\$ret"/);
    assert.match(script, /"SessionStart":\[\{"matcher":"startup\|resume"/);
    assert.match(script, /\\"event\\":\\"idle\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
    assert.match(script, /\\"event\\":\\"stop\\",\\"session\\":\\"\$\{sid\}\\",\\"agent\\":\\"\$\{agent\}\\"/);
  }
});

test("agent lifecycle policy is centralized", () => {
  const policy = read("src/modules/terminal/lib/agent-lifecycle.ts");

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
  assert.match(policy, /function hasCodexBusyIndicator\(text: string\): boolean \{[\s\S]*\\bWorking\\b[\s\S]*Pursuing goal[\s\S]*background terminal running/);
  assert.match(policy, /if \(hasCodexBusyIndicator\(afterPromptText\)\) return "busy";[\s\S]*if \(afterPrompt\.length <= 4\) return "ready";[\s\S]*if \(hasCodexBusyIndicator\(recentText\)\) \{/);
});

test("session store separates agent identity from busy state", () => {
  const types = read("src/ui/types.ts");
  const source = read("src/state/sessions.ts");

  assert.match(types, /export type AgentActivity = "starting" \| "idle" \| "running";/);
  assert.match(types, /agentActivity\?: AgentActivity;/);
  assert.match(types, /suppressShellTitle\?: boolean;/);
  assert.match(types, /export function isPromptLikeShellTitle\(title: string\): boolean/);
  assert.match(types, /const lastCommand = s\.lastCommand && !isPromptLikeShellTitle\(s\.lastCommand\)/);
  assert.match(types, /&& !s\.suppressShellTitle[\s\S]*&& !isPromptLikeShellTitle\(s\.shellTitle\)/);
  assert.match(types, /primary = s\.title && !isPromptLikeShellTitle\(s\.title\) \? s\.title : "终端";/);
  assert.match(source, /agentActivity: opts\?\.agent \? initialAgentActivity\(opts\.agent\) : undefined,/);
  assert.match(source, /handleAgentDetected: \(id, agent\) => \{[\s\S]*?agentActivity: initialAgentActivity\(agent\),[\s\S]*?runState: "idle",/);
  assert.match(source, /handleAgentReady: \(id\) => \{[\s\S]*?agentActivity: "idle",[\s\S]*?runState: "idle",/);
  assert.match(source, /handleAgentBusy: \(id\) => \{[\s\S]*?agentActivity: "running",[\s\S]*?runState: "idle",/);
  assert.match(source, /handleAgentExited: \(id, exitCode\) => \{[\s\S]*?agent: undefined,[\s\S]*?agentActivity: undefined,[\s\S]*?title: "终端",/);
  assert.match(source, /handleAgentExited: \(id, exitCode\) => \{[\s\S]*?suppressShellTitle: true,/);
  assert.match(source, /handleCommandDetected: \(id, command\) => \{[\s\S]*?suppressShellTitle: false,/);
  assert.match(source, /if \(session\?\.agent \|\| session\?\.suppressShellTitle \|\| isAgentShellTitle\(title\) \|\| isPromptLikeShellTitle\(title\)\) return;/);
  assert.match(source, /if \(session\?\.agent \|\| isPromptLikeShellTitle\(command\)\) return;/);
  assert.match(source, /if \(session\?\.agent \|\| !session\?\.lastCommand\) \{/);
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
  assert.match(terminal, /import \{ detectAgentCommand, detectCodexScreenState, HOOK_READY_AGENTS, PROMPT_READY_AGENTS \}/);
  assert.doesNotMatch(terminal, /const HOOKABLE_AGENTS/);
  assert.doesNotMatch(terminal, /const PROMPT_DETECTED_AGENTS/);
  assert.match(terminal, /agentStartupPending = HOOK_READY_AGENTS\.has\(agent\);/);
  assert.match(terminal, /const syncAgentTrackingFromStore = \(\) => \{[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /useSessionsStore\.subscribe[\s\S]*!hasAgent \|\| currentAgentCode !== sess\.agent[\s\S]*currentAgentCode = sess\.agent;/);
  assert.match(terminal, /const trackedSession = syncAgentTrackingFromStore\(\);[\s\S]*if \(hasAgent \|\| trackedSession\?\.agent\) \{/);
  assert.match(terminal, /if \(PROMPT_READY_AGENTS\.has\(currentAgentCode\)\) \{[\s\S]*?scheduleCodexStateCheck\(\);[\s\S]*?return;/);
  assert.match(terminal, /const screenState = detectCodexScreenState\(tail\);[\s\S]*if \(screenState === "ready"\)[\s\S]*handleAgentReady\(sessionIdRef\.current\)[\s\S]*if \(screenState === "busy"\)[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /const submitted = cleanTerminalText\(inputBuffer\)\.trim\(\);[\s\S]*if \(!submitted\) return;[\s\S]*handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentBusy\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentReady\(sessionIdRef\.current\)/);
  assert.match(terminal, /handleAgentExited\(sessionIdRef\.current, exitCode\)/);
});

test("UI renders busy state from unified helpers without sidebar progress bars", () => {
  const card = read("src/ui/SessionCard.tsx");
  const status = read("src/ui/AgentStatusBar.tsx");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");

  assert.match(card, /import \{ isSessionBusy, sessionDisplayRunState \}/);
  assert.match(card, /const displayRunState = sessionDisplayRunState\(session\);/);
  assert.match(card, /const busy = isSessionBusy\(session\);/);
  assert.doesNotMatch(card, /const showBusyProgress = session\.runState === "running";/);
  assert.doesNotMatch(card, /showBusyProgress/);
  assert.doesNotMatch(card, /indeterminate/);
  assert.match(status, /import \{ isAgentActivityBusy \}/);
  assert.match(status, /const isBusy = !!session\.agent && isAgentActivityBusy\(session\.agentActivity\);/);
  assert.match(main, /isAgentActivityBusy\(active\.agentActivity\)/);
  assert.match(diff, /const busy = isSessionBusy\(session\);/);
  assert.doesNotMatch(diff, /session\.runState !== "running"/);
});
