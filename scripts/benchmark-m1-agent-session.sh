#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE="$ROOT/scripts/smoke-agent-tui.exp"
RESULTS_ROOT="${TUNARA_AGENT_SESSION_RESULTS:-/tmp/tunara-m1-agent-session}"
RESULT="$RESULTS_ROOT/result-summary.json"
TARGET="${TUNARA_M1_SSH_TARGET:-de-netcup}"
mkdir -p "$RESULTS_ROOT"
WORK="$(mktemp -d "$RESULTS_ROOT/.work.XXXXXXXX")"
FIRST_ROOT="$(mktemp -d /tmp/tunara-first-permission.XXXXXXXX)"
RESUME_ROOT="$(mktemp -d /tmp/tunara-agent-resume.XXXXXXXX)"
CLAUDE_PROBE="/tmp/.tunara-claude-permission-probe-$$"

cleanup() {
  rm -f "$CLAUDE_PROBE"
  rm -rf "$FIRST_ROOT" "$RESUME_ROOT"
  if [[ "${TUNARA_KEEP_AGENT_SESSION_LOGS:-0}" != "1" ]]; then
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

git -C "$FIRST_ROOT" init -q
git -C "$RESUME_ROOT" init -q

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

extract_json_id() {
  python3 - "$1" "$2" <<'PY'
import json, sys
from pathlib import Path
path, key = sys.argv[1:3]
for line in Path(path).read_text(errors="replace").splitlines():
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(obj, dict) and isinstance(obj.get(key), str):
        print(obj[key])
        raise SystemExit(0)
raise SystemExit(1)
PY
}

"$SMOKE" "$WORK/permission-codex.log" /bin/zsh -lc \
  "cd '$FIRST_ROOT' && exec codex --sandbox read-only -c approval_policy='untrusted'" \
  > "$WORK/permission-codex.summary" &
permission_codex_pid=$!
"$SMOKE" "$WORK/permission-claude.log" /bin/zsh -lc \
  "cd '$FIRST_ROOT' && exec claude --permission-mode default 'Use the Bash tool to run exactly: touch $CLAUDE_PROBE. Do not use any other tool.'" \
  > "$WORK/permission-claude.summary" &
permission_claude_pid=$!

claude_session="$(uuidgen | tr '[:upper:]' '[:lower:]')"
(
  cd "$RESUME_ROOT"
  timeout 120 claude -p --session-id "$claude_session" --permission-mode dontAsk --output-format json \
    "Remember the token TUNARA_CLAUDE_CONTEXT_7419 and reply exactly TUNARA_CLAUDE_FIRST_OK." \
    > "$WORK/resume-local-claude-first.log" 2>&1
  timeout 120 claude -p --resume "$claude_session" --permission-mode dontAsk --output-format json \
    "If the remembered token is TUNARA_CLAUDE_CONTEXT_7419, reply exactly TUNARA_CLAUDE_RESUME_OK." \
    > "$WORK/resume-local-claude-resume.log" 2>&1
) &
resume_claude_pid=$!

(
  cd "$RESUME_ROOT"
  timeout 120 codex exec --sandbox read-only --skip-git-repo-check --json \
    "Remember the token TUNARA_CODEX_CONTEXT_8527 and reply exactly TUNARA_CODEX_FIRST_OK." \
    > "$WORK/resume-local-codex-first.log" 2>&1
  thread="$(extract_json_id "$WORK/resume-local-codex-first.log" thread_id)"
  timeout 120 codex exec resume --skip-git-repo-check "$thread" --json \
    "If the remembered token is TUNARA_CODEX_CONTEXT_8527, reply exactly TUNARA_CODEX_RESUME_OK." \
    > "$WORK/resume-local-codex-resume.log" 2>&1
) &
resume_codex_pid=$!

(
  printf '%s' "Remember the token TUNARA_SSH_CODEX_CONTEXT_9631 and reply exactly TUNARA_SSH_CODEX_FIRST_OK." | \
    ssh "${ssh_args[@]}" "$remote" \
      "cd /tmp && timeout 120 codex exec --sandbox read-only --skip-git-repo-check --json -" \
      > "$WORK/resume-ssh-codex-first.log" 2>&1
  thread="$(extract_json_id "$WORK/resume-ssh-codex-first.log" thread_id)"
  printf '%s' "If the remembered token is TUNARA_SSH_CODEX_CONTEXT_9631, reply exactly TUNARA_SSH_CODEX_RESUME_OK." | \
    ssh "${ssh_args[@]}" "$remote" \
      "cd /tmp && timeout 120 codex exec resume --skip-git-repo-check '$thread' --json -" \
      > "$WORK/resume-ssh-codex-resume.log" 2>&1
) &
resume_ssh_codex_pid=$!

ssh "${ssh_args[@]}" "$remote" "/bin/bash -s" \
  < "$ROOT/scripts/remote-aider-resume.sh" \
  > "$WORK/resume-ssh-aider.json" 2>&1 &
resume_ssh_aider_pid=$!

"$ROOT/scripts/opencode-resume-probe.sh" \
  > "$WORK/resume-local-opencode.json" 2>&1 &
resume_local_opencode_pid=$!

ssh "${ssh_args[@]}" "$remote" "/bin/bash -s" \
  < "$ROOT/scripts/opencode-resume-probe.sh" \
  > "$WORK/resume-ssh-opencode.json" 2>&1 &
resume_ssh_opencode_pid=$!

"$ROOT/scripts/pi-resume-probe.sh" \
  > "$WORK/resume-local-pi.json" 2>&1 &
resume_local_pi_pid=$!

TUNARA_PI_USE_NPX=1 ssh "${ssh_args[@]}" "$remote" \
  "TUNARA_PI_USE_NPX=1 /bin/bash -s" \
  < "$ROOT/scripts/pi-resume-probe.sh" \
  > "$WORK/resume-ssh-pi.json" 2>&1 &
resume_ssh_pi_pid=$!

ssh "${ssh_args[@]}" "$remote" "/bin/bash -s" \
  < "$ROOT/scripts/remote-claude-resume.sh" \
  > "$WORK/resume-ssh-claude.json" 2>&1 &
resume_ssh_claude_pid=$!

wait "$permission_codex_pid" || true
wait "$permission_claude_pid" || true
[[ -e "$CLAUDE_PROBE" ]] && printf '1\n' > "$WORK/permission-claude-probe-created" \
  || printf '0\n' > "$WORK/permission-claude-probe-created"
wait "$resume_claude_pid"
wait "$resume_codex_pid"
wait "$resume_ssh_codex_pid"
wait "$resume_ssh_aider_pid"
wait "$resume_local_opencode_pid"
wait "$resume_ssh_opencode_pid"
wait "$resume_local_pi_pid"
wait "$resume_ssh_pi_pid"
wait "$resume_ssh_claude_pid"

python3 "$ROOT/scripts/summarize-agent-session.py" \
  --input "$WORK" \
  --output "$RESULT" \
  --commit "$(git -C "$ROOT" rev-parse HEAD)" \
  --target "$TARGET"

echo "Agent session benchmark complete: $RESULT"
python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["summary"], indent=2))' "$RESULT"
