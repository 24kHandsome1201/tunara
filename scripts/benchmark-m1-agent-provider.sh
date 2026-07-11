#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_ROOT="${TUNARA_AGENT_PROVIDER_RESULTS:-/tmp/tunara-m1-agent-provider}"
RESULT="$RESULTS_ROOT/result-summary.json"
TARGET="${TUNARA_M1_SSH_TARGET:-de-netcup}"
mkdir -p "$RESULTS_ROOT"
WORK="$(mktemp -d "$RESULTS_ROOT/.work.XXXXXXXX")"
mkdir -p "$WORK/local" "$WORK/ssh"
trap 'rm -rf "$WORK"' EXIT

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

capture() {
  local scope="$1" agent="$2"
  shift 2
  (
    set +e
    "$@" > "$WORK/$scope/$agent.log" 2>&1
    printf '%s\n' "$?" > "$WORK/$scope/$agent.rc"
  ) &
  jobs+=("$!")
}

capture_pipe() {
  local scope="$1" agent="$2" prompt="$3"
  shift 3
  (
    set +e
    printf '%s' "$prompt" | "$@" > "$WORK/$scope/$agent.log" 2>&1
    printf '%s\n' "$?" > "$WORK/$scope/$agent.rc"
  ) &
  jobs+=("$!")
}

jobs=()
capture_pipe local claude \
  "Use the Read tool to read package.json, then reply exactly TUNARA_LOCAL_CLAUDE_TOOL_OK." \
  timeout 120 claude -p --no-session-persistence --permission-mode dontAsk \
  --allowedTools Read --output-format stream-json --verbose
capture_pipe local codex \
  "Use the shell tool to run pwd, then reply exactly TUNARA_LOCAL_CODEX_TOOL_OK." \
  timeout 120 codex exec --ephemeral --sandbox read-only --skip-git-repo-check --json -
capture local pi timeout 60 pi --no-session --no-tools -p "Reply exactly TUNARA_LOCAL_PI_OK."
capture local opencode timeout 60 opencode run --pure --format json \
  "Reply exactly TUNARA_LOCAL_OPENCODE_OK."
capture local aider /bin/zsh -lc \
  "cd /tmp && exec timeout 60 uvx --from aider-chat aider --no-git --no-auto-commits --yes-always --model openai/gpt-4o-mini --message 'Reply exactly TUNARA_LOCAL_AIDER_OK.'"

capture_pipe ssh claude \
  "Use the Read tool to read /etc/hostname, then reply exactly TUNARA_SSH_CLAUDE_TOOL_OK." \
  ssh "${ssh_args[@]}" "$remote" \
  "timeout 120 claude -p --no-session-persistence --permission-mode dontAsk --allowedTools Read --output-format stream-json --verbose"
capture_pipe ssh codex \
  "Use the shell tool to run pwd, then reply exactly TUNARA_SSH_CODEX_TOOL_OK." \
  ssh "${ssh_args[@]}" "$remote" \
  "timeout 120 codex exec --ephemeral --sandbox read-only --skip-git-repo-check --json -"
capture_pipe ssh pi "Reply exactly TUNARA_SSH_PI_OK." \
  ssh "${ssh_args[@]}" "$remote" \
  "timeout 60 npx -y @earendil-works/pi-coding-agent@0.79.4 --no-session --no-tools -p"
capture_pipe ssh opencode "Reply exactly TUNARA_SSH_OPENCODE_OK." \
  ssh "${ssh_args[@]}" "$remote" "timeout 60 opencode run --pure --format json"
capture_pipe ssh aider "Reply exactly TUNARA_SSH_AIDER_OK." \
  ssh "${ssh_args[@]}" "$remote" \
  "cd /tmp && timeout 60 aider --no-git --no-auto-commits --yes-always --model openai/gpt-4o-mini --message-file -"

for pid in "${jobs[@]}"; do
  wait "$pid"
done

python3 "$ROOT/scripts/summarize-agent-provider.py" \
  --input "$WORK" \
  --output "$RESULT" \
  --commit "$(git -C "$ROOT" rev-parse HEAD)" \
  --target "$TARGET"

echo "Agent provider benchmark complete: $RESULT"
python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["summary"], indent=2))' "$RESULT"
