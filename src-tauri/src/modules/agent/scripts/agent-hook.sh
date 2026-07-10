#!/bin/sh
# Tunara agent lifecycle hook helper (written by the host at startup).
#
# Invoked by an agent's own hook system (e.g. Claude Code SessionStart/Stop/
# Notification) as: sh agent-hook.sh <event> <agent> <logical_session>
# The agent passes its hook payload JSON on stdin, which carries the agent's
# real session_id. We extract it and emit OSC 777 to the controlling terminal,
# then also relay it over the host hook socket when available. The duplicate
# channels are intentional and the frontend transitions are idempotent: `/dev/tty`
# keeps turn state working without `nc`, while the socket also works when a hook
# process cannot open its controlling terminal.
#
# No jq dependency: extract "session_id" with tr/grep/cut. Field-name is quoted
# in the match so look-alike keys (e.g. *_session_id) don't get picked up.

merge_settings() {
  user_source="$1"
  tunara_source="$2"
  output="$3"
  [ -n "$user_source" ] && [ -f "$tunara_source" ] && [ -n "$output" ] || return 1
  umask 077

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$user_source" "$tunara_source" "$output" <<'PY'
import json, os, sys

user_source, tunara_source, output = sys.argv[1:]

def load_source(source):
    stripped = source.lstrip()
    if stripped.startswith("{"):
        value = json.loads(source)
    else:
        with open(os.path.expanduser(source), encoding="utf-8") as handle:
            value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("settings root must be an object")
    return value

user = load_source(user_source)
tunara = load_source(tunara_source)
user_hooks = user.get("hooks", {})
tunara_hooks = tunara.get("hooks", {})
if user_hooks is None:
    user_hooks = {}
if tunara_hooks is None:
    tunara_hooks = {}
if not isinstance(user_hooks, dict) or not isinstance(tunara_hooks, dict):
    raise ValueError("hooks must be an object")

result = dict(user)
for key, value in tunara.items():
    if key != "hooks":
        result.setdefault(key, value)
merged_hooks = dict(user_hooks)
for event, entries in tunara_hooks.items():
    existing = merged_hooks.get(event, [])
    if existing is None:
        existing = []
    if not isinstance(existing, list) or not isinstance(entries, list):
        raise ValueError("hook event values must be arrays")
    merged_hooks[event] = existing + entries
result["hooks"] = merged_hooks

with open(output, "w", encoding="utf-8") as handle:
    json.dump(result, handle, separators=(",", ":"))
os.chmod(output, 0o600)
PY
    return $?
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$user_source" "$tunara_source" "$output" <<'JS'
const fs = require("fs");
const os = require("os");
const path = require("path");
const [userSource, tunaraSource, output] = process.argv.slice(2);
function loadSource(source) {
  const trimmed = source.trimStart();
  const filename = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
  const value = JSON.parse(trimmed.startsWith("{") ? source : fs.readFileSync(filename, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("settings root must be an object");
  return value;
}
const user = loadSource(userSource);
const tunara = loadSource(tunaraSource);
const userHooks = user.hooks ?? {};
const tunaraHooks = tunara.hooks ?? {};
if (Array.isArray(userHooks) || typeof userHooks !== "object" || Array.isArray(tunaraHooks) || typeof tunaraHooks !== "object") throw new Error("hooks must be an object");
const result = { ...user };
for (const [key, value] of Object.entries(tunara)) if (key !== "hooks" && !(key in result)) result[key] = value;
const hooks = { ...userHooks };
for (const [event, entries] of Object.entries(tunaraHooks)) {
  const existing = hooks[event] ?? [];
  if (!Array.isArray(existing) || !Array.isArray(entries)) throw new Error("hook event values must be arrays");
  hooks[event] = [...existing, ...entries];
}
result.hooks = hooks;
fs.writeFileSync(output, JSON.stringify(result), { mode: 0o600 });
fs.chmodSync(output, 0o600);
JS
    return $?
  fi

  if command -v jq >/dev/null 2>&1 && [ -f "$user_source" ]; then
    jq -c -s '
      .[0] as $user | .[1] as $tunara |
      (($tunara | del(.hooks)) * $user) |
      .hooks = (reduce (((($user.hooks // {}) | keys) + (($tunara.hooks // {}) | keys) | unique)[]) as $event
        ({}; .[$event] = (($user.hooks[$event] // []) + ($tunara.hooks[$event] // []))))
    ' "$user_source" "$tunara_source" > "$output" || return 1
    chmod 600 "$output" 2>/dev/null || true
    return 0
  fi

  return 1
}

if [ "${1:-}" = "merge-settings" ]; then
  [ "$#" -eq 4 ] || exit 2
  merge_settings "$2" "$3" "$4"
  exit $?
fi

asid="$(tr ',' '\n' | grep '"session_id"' | head -1 | tr -d ' ' | cut -d'"' -f4)"
case "$asid" in *[!A-Za-z0-9_-]*|'') asid="" ;; esac
[ "${#asid}" -le 256 ] || asid=""
printf '\033]777;tunara-agent;%s;%s;%s;%s;%s\033\\' \
  "$1" "$3" "$2" "${4:-}" "$asid" > /dev/tty 2>/dev/null || true
[ -n "$TUNARA_HOOKS_SOCK" ] || exit 0
printf '{"event":"%s","session":"%s","agent":"%s","agent_session_id":"%s"}' \
  "$1" "$3" "$2" "$asid" | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1 || true
