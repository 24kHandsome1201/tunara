#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE="$ROOT/scripts/smoke-agent-tui.exp"
FIXTURE="$ROOT/scripts/fixtures/unknown-tui.py"
SUMMARIZER="$ROOT/scripts/summarize-agent-tui.py"
RESULTS_ROOT="${TUNARA_AGENT_TUI_RESULTS:-/tmp/tunara-m1-agent-tui}"
RESULT="$RESULTS_ROOT/result-summary.json"
mkdir -p "$RESULTS_ROOT"
WORK="$(mktemp -d "$RESULTS_ROOT/.work.XXXXXXXX")"
TARGET="${TUNARA_M1_SSH_TARGET:-de-netcup}"

mkdir -p "$WORK/local" "$WORK/ssh"

cleanup() {
  if [[ -n "${remote:-}" && -n "${remote_fixture:-}" ]]; then
    ssh "${ssh_args[@]}" "$remote" "rm -f '$remote_fixture'" >/dev/null 2>&1 || true
  fi
  if [[ "${TUNARA_KEEP_AGENT_TUI_LOGS:-0}" != "1" ]]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

record_unavailable() {
  local scope="$1" name="$2" reason="$3"
  printf '%s\n' "$reason" > "$WORK/$scope/$name.unavailable"
}

run_local() {
  local name="$1" version_command="$2" command="$3" exit_method="$4"
  if ! /bin/zsh -lc "command -v ${command%% *}" >/dev/null 2>&1; then
    record_unavailable local "$name" "command unavailable"
    return
  fi
  /bin/zsh -lc "$version_command" > "$WORK/local/$name.version" 2>/dev/null || true
  TUNARA_TUI_EXERCISE_INPUT=1 TUNARA_TUI_EXIT_METHOD="$exit_method" \
    "$SMOKE" "$WORK/local/$name.log" /bin/zsh -lc "exec $command" \
    > "$WORK/local/$name.summary" &
  jobs+=("$!")
}

wait_jobs() {
  local pid
  for pid in "${jobs[@]}"; do
    wait "$pid"
  done
  jobs=()
}

jobs=()
run_local claude "claude --version" "claude" slash
run_local codex "codex --version" "codex --sandbox read-only" eof
run_local pi "pi --version" "pi --no-session" slash
run_local opencode "opencode --version" "opencode" eof
if command -v uvx >/dev/null 2>&1; then
  /bin/zsh -lc "uvx --from aider-chat aider --version" > "$WORK/local/aider.version" 2>/dev/null || true
  TUNARA_TUI_EXERCISE_INPUT=1 TUNARA_TUI_EXIT_METHOD=slash \
    "$SMOKE" "$WORK/local/aider.log" /bin/zsh -lc \
    "cd /tmp && exec uvx --from aider-chat aider --no-git" > "$WORK/local/aider.summary" &
  jobs+=("$!")
else
  record_unavailable local aider "uvx unavailable"
fi
TUNARA_TUI_EXERCISE_INPUT=1 "$SMOKE" "$WORK/local/unknown.log" "$FIXTURE" > "$WORK/local/unknown.summary" &
jobs+=("$!")
printf '%s\n' "deterministic fixture" > "$WORK/local/unknown.version"
wait_jobs

ssh_config="$(ssh -G "$TARGET" 2>/dev/null)"
host="${TUNARA_M1_REMOTE_HOST:-$(awk '$1 == "hostname" { print $2; exit }' <<< "$ssh_config")}"
port="${TUNARA_M1_REMOTE_PORT:-$(awk '$1 == "port" { print $2; exit }' <<< "$ssh_config")}"
user="${TUNARA_M1_REMOTE_USER:-$(awk '$1 == "user" { print $2; exit }' <<< "$ssh_config")}"
identity="${TUNARA_M1_REMOTE_IDENTITY_FILE:-}"
if [[ -z "$identity" ]]; then
  while read -r candidate; do
    candidate="${candidate/#\~/$HOME}"
    if [[ -f "$candidate" ]]; then
      identity="$candidate"
      break
    fi
  done < <(awk '$1 == "identityfile" { print $2 }' <<< "$ssh_config")
fi
if [[ -z "$host" || -z "$port" || -z "$user" || -z "$identity" ]]; then
  echo "Could not resolve SSH target $TARGET" >&2
  exit 2
fi

ssh_args=(-i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -p "$port")
remote="$user@$host"
remote_fixture="/tmp/.tunara-unknown-tui-$$.py"
scp -q -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -P "$port" \
  "$FIXTURE" "$remote:$remote_fixture"

remote_version() {
  local name="$1" command="$2"
  ssh "${ssh_args[@]}" "$remote" "$command" > "$WORK/ssh/$name.version" 2>/dev/null || true
}

remote_available() {
  ssh "${ssh_args[@]}" "$remote" "command -v '$1' >/dev/null 2>&1"
}

run_remote() {
  local name="$1" binary="$2" exit_method="$3"
  shift 3
  if ! remote_available "$binary"; then
    record_unavailable ssh "$name" "command unavailable"
    return
  fi
  TUNARA_TUI_EXERCISE_INPUT=1 TUNARA_TUI_EXIT_METHOD="$exit_method" \
    "$SMOKE" "$WORK/ssh/$name.log" ssh "${ssh_args[@]}" -tt "$remote" "$@" \
    > "$WORK/ssh/$name.summary" &
  jobs+=("$!")
}

remote_version claude "claude --version"
remote_version codex "codex --version"
remote_version pi "npx -y @earendil-works/pi-coding-agent@0.79.4 --version"
remote_version opencode "opencode --version"
run_remote claude claude slash claude
run_remote codex codex eof codex --sandbox read-only
if remote_available pi; then
  run_remote pi pi slash pi --no-session
elif remote_available npx; then
  TUNARA_TUI_EXERCISE_INPUT=1 TUNARA_TUI_EXIT_METHOD=slash \
    "$SMOKE" "$WORK/ssh/pi.log" ssh "${ssh_args[@]}" -tt "$remote" \
    npx -y @earendil-works/pi-coding-agent@0.79.4 --no-session > "$WORK/ssh/pi.summary" &
  jobs+=("$!")
else
  record_unavailable ssh pi "pi and npx unavailable"
fi
run_remote opencode opencode slash opencode
if remote_available aider; then
  remote_version aider "aider --version"
  TUNARA_TUI_EXERCISE_INPUT=1 TUNARA_TUI_EXIT_METHOD=slash \
    "$SMOKE" "$WORK/ssh/aider.log" ssh "${ssh_args[@]}" -tt "$remote" \
    "cd /tmp && exec aider --no-git" > "$WORK/ssh/aider.summary" &
  jobs+=("$!")
else
  record_unavailable ssh aider "command unavailable"
fi
TUNARA_TUI_EXERCISE_INPUT=1 "$SMOKE" "$WORK/ssh/unknown.log" ssh "${ssh_args[@]}" -tt "$remote" \
  python3 "$remote_fixture" > "$WORK/ssh/unknown.summary" &
jobs+=("$!")
printf '%s\n' "deterministic fixture" > "$WORK/ssh/unknown.version"
wait_jobs

python3 "$SUMMARIZER" \
  --input "$WORK" \
  --output "$RESULT" \
  --commit "$(git -C "$ROOT" rev-parse HEAD)" \
  --target "$TARGET" \
  --macos "$(sw_vers -productVersion) ($(sw_vers -buildVersion))"

echo "Agent TUI benchmark complete: $RESULT"
python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["summary"], indent=2))' "$RESULT"
