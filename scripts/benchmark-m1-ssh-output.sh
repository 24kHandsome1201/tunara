#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCHMARK="$ROOT/scripts/benchmark-m1-terminal-output.sh"
ACTION="${1:-all}"
TARGET="${TUNARA_M1_SSH_TARGET:-de-netcup}"
REMOTE_CWD="${TUNARA_M1_REMOTE_CWD:-/root/qclaw-wechat-client}"
REMOTE_FIXTURE_DIR="${TUNARA_M1_REMOTE_FIXTURE_DIR:-/tmp/tunara-m1-benchmark}"
REMOTE_FIXTURE="$REMOTE_FIXTURE_DIR/terminal-output-fixture.mjs"

if [[ "$ACTION" == "stop" ]]; then
  exec "$BENCHMARK" stop
fi

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
  echo "Could not resolve host, port, user, and identity file for $TARGET" >&2
  exit 2
fi
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Resolved SSH port is invalid: $port" >&2
  exit 2
fi
if [[ "$REMOTE_CWD" != /* ]]; then
  echo "TUNARA_M1_REMOTE_CWD must be an absolute POSIX path" >&2
  exit 2
fi

ssh_args=(-i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -p "$port")
remote="$user@$host"

cleanup_remote() {
  ssh "${ssh_args[@]}" "$remote" "rm -rf '$REMOTE_FIXTURE_DIR'" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

ssh "${ssh_args[@]}" "$remote" \
  "test -d '$REMOTE_CWD' && mkdir -p '$REMOTE_FIXTURE_DIR' && chmod 700 '$REMOTE_FIXTURE_DIR'"
scp -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -P "$port" \
  "$ROOT/scripts/terminal-output-fixture.mjs" "$remote:$REMOTE_FIXTURE"
local_sha="$(shasum -a 256 "$ROOT/scripts/terminal-output-fixture.mjs" | awk '{ print $1 }')"
remote_sha="$(ssh "${ssh_args[@]}" "$remote" "sha256sum '$REMOTE_FIXTURE'" | awk '{ print $1 }')"
if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "Remote terminal fixture checksum mismatch" >&2
  exit 3
fi

remote_node="$(ssh "${ssh_args[@]}" "$remote" 'command -v node')"
remote_branch="$(ssh "${ssh_args[@]}" "$remote" "git -C '$REMOTE_CWD' branch --show-current 2>/dev/null || true")"

TUNARA_BENCHMARK_RESULTS="${TUNARA_BENCHMARK_RESULTS:-/tmp/tunara-m1-ssh-output-benchmark}" \
TUNARA_M1_BENCHMARK_TRANSPORT=ssh \
TUNARA_M1_BENCHMARK_NODE="$remote_node" \
TUNARA_M1_BENCHMARK_FIXTURE_PATH="$REMOTE_FIXTURE" \
TUNARA_M1_FIXTURE_TIMEOUT_MS="${TUNARA_M1_FIXTURE_TIMEOUT_MS:-1800000}" \
TUNARA_M1_WAIT_SECONDS="${TUNARA_M1_WAIT_SECONDS:-2700}" \
TUNARA_M1_REMOTE_HOST="$host" \
TUNARA_M1_REMOTE_PORT="$port" \
TUNARA_M1_REMOTE_USER="$user" \
TUNARA_M1_REMOTE_CWD="$REMOTE_CWD" \
TUNARA_M1_REMOTE_IDENTITY_FILE="$identity" \
TUNARA_M1_REMOTE_BRANCH="$remote_branch" \
  "$BENCHMARK" "$ACTION"
