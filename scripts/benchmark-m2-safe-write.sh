#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
TARGET="${TUNARA_M2_SSH_TARGET:-de-netcup}"
IDENTIFIER="dev.tunara.m2benchmark"
PRODUCT_NAME="Tunara M2 Safe Write Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
RESULTS_ROOT="${TUNARA_M2_RESULTS:-/tmp/tunara-m2-safe-write-benchmark-results}"
WAIT_SECONDS="${TUNARA_M2_WAIT_SECONDS:-180}"

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || (( WAIT_SECONDS < 1 )); then
  echo "TUNARA_M2_WAIT_SECONDS must be a positive integer" >&2
  exit 2
fi

ssh_config="$(ssh -G "$TARGET" 2>/dev/null)"
host="${TUNARA_M2_REMOTE_HOST:-$(awk '$1 == "hostname" { print $2; exit }' <<< "$ssh_config")}"
port="${TUNARA_M2_REMOTE_PORT:-$(awk '$1 == "port" { print $2; exit }' <<< "$ssh_config")}"
user="${TUNARA_M2_REMOTE_USER:-$(awk '$1 == "user" { print $2; exit }' <<< "$ssh_config")}"
identity="${TUNARA_M2_REMOTE_IDENTITY_FILE:-}"
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

ssh_args=(-i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -p "$port")
remote="$user@$host"
nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$"
fixture_dir="/tmp/tunara-m2-safe-write-benchmark-$nonce"
fixture_path="$fixture_dir/fixture.md"
unknown_expected_sha="$(printf 'after\n' | shasum -a 256 | awk '{ print $1 }')"
final_expected_sha="$(printf 'other\n' | shasum -a 256 | awk '{ print $1 }')"

stop_bundle() {
  pkill -f "$APP_BIN" 2>/dev/null || true
}

cleanup_remote() {
  ssh "${ssh_args[@]}" "$remote" "rm -rf -- '$fixture_dir'" >/dev/null 2>&1 || true
}

build_bundle() {
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m2-safe-write \
  VITE_TUNARA_BENCHMARK_TRANSPORT=ssh \
  VITE_TUNARA_M2_EXPECTED_SHA256="$unknown_expected_sha" \
  VITE_TUNARA_M2_EXTERNAL_SHA256="$final_expected_sha" \
    pnpm tauri build --features m2-safe-write-benchmark --bundles app --config \
      "{\"identifier\":\"$IDENTIFIER\",\"productName\":\"$PRODUCT_NAME\",\"app\":{\"security\":{\"capabilities\":[\"default\",\"desktop-capability\",{\"identifier\":\"m2-safe-write-benchmark\",\"windows\":[\"main\"],\"permissions\":[\"m2-safe-write-benchmark:allow-arm-release-failure\"]}]}}}"
}

write_workspace_fixture() {
  local now store
  now="$(($(date +%s) * 1000))"
  store="$APP_SUPPORT/tunara-sessions.json"
  mkdir -p "$APP_SUPPORT"
  jq -n \
    --arg dir "$fixture_dir" \
    --arg host "$host" \
    --arg user "$user" \
    --arg identity "$identity" \
    --argjson port "$port" \
    --argjson now "$now" '
      {
        workspaceSnapshot: {
          version: 1,
          savedAt: $now,
          activeSessionId: "m2-safe-write-0",
          sessions: [{
            id: "m2-safe-write-0",
            title: "M2 SSH 安全写验收",
            dir: $dir,
            branch: "",
            mascot: "otter",
            remote: {
              host: $host,
              port: $port,
              user: $user,
              identityFile: $identity,
              injectShellIntegration: true
            },
            updatedAt: $now
          }],
          terminals: {},
          agentResume: {},
          recentDirs: [$dir],
          recentCommands: [],
          commandUsage: {},
          workflows: [],
          ui: {
            sidebarVisible: true,
            panelVisible: true,
            collapsedDirs: {},
            collapsedDiffSections: {},
            inspectorTab: "files",
            split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 }
          }
        }
      }
    ' > "$store"
}

run_benchmark() {
  if ioreg -n Root -d1 | grep -F '"IOConsoleLocked" = Yes' >/dev/null; then
    echo "The macOS console is locked. Unlock it before running the GUI benchmark." >&2
    exit 3
  fi
  if [[ ! -x "$APP_BIN" ]]; then
    echo "Benchmark bundle is missing. Run: $0 build" >&2
    exit 4
  fi

  stop_bundle
  trap cleanup_remote EXIT
  ssh "${ssh_args[@]}" "$remote" \
    "install -d -m 700 '$fixture_dir' && printf 'before\\n' > '$fixture_path' && chmod 640 '$fixture_path'"
  write_workspace_fixture

  local stamp result_dir log pid line observed_sha observed_mode residue_count
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp"
  log="$result_dir/app.log"
  mkdir -p "$result_dir"
  RUST_LOG=info "$APP_BIN" > "$log" 2>&1 &
  pid=$!
  trap "kill '$pid' 2>/dev/null || true; cleanup_remote" EXIT

  line=""
  for _ in $(seq 1 "$((WAIT_SECONDS * 4))"); do
    line="$(grep -F '[benchmark:m2-safe-write]' "$log" | tail -1 || true)"
    if [[ -n "$line" ]]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [[ -z "$line" ]]; then
    echo "M2 benchmark did not emit a result within ${WAIT_SECONDS}s" >&2
    tail -80 "$log" >&2 || true
    exit 5
  fi
  printf '%s\n' "$line" | sed 's/^.*\[benchmark:m2-safe-write\] //' | jq . > "$result_dir/gui.json"

  observed_sha="$(ssh "${ssh_args[@]}" "$remote" "sha256sum '$fixture_path'" | awk '{ print $1 }')"
  observed_mode="$(ssh "${ssh_args[@]}" "$remote" "stat -c %a '$fixture_path'")"
  residue_count="$(ssh "${ssh_args[@]}" "$remote" "find '$fixture_dir' -maxdepth 1 \\( -name '*.tunara-*.tmp' -o -name '.tunara-write-*.lock' \\) -print | wc -l" | tr -d '[:space:]')"
  jq -n \
    --arg fingerprint "$observed_sha" \
    --arg expectedFingerprint "$final_expected_sha" \
    --arg mode "$observed_mode" \
    --argjson residueCount "$residue_count" '
      {
        fingerprint: $fingerprint,
        expectedFingerprint: $expectedFingerprint,
        modeOctal: $mode,
        residueCount: $residueCount,
        passed: ($fingerprint == $expectedFingerprint and $mode == "640" and $residueCount == 0)
      }
    ' > "$result_dir/remote.json"
  jq -s '.[0] + { independentRemote: .[1], passed: (.[0].passed and .[1].passed) }' \
    "$result_dir/gui.json" "$result_dir/remote.json" > "$result_dir/result.json"
  jq . "$result_dir/result.json"
  jq -e '.passed == true' "$result_dir/result.json" >/dev/null
}

case "$ACTION" in
  build) build_bundle ;;
  run) run_benchmark ;;
  all) build_bundle; run_benchmark ;;
  stop) stop_bundle ;;
  *) echo "Usage: $0 [build|run|all|stop]" >&2; exit 2 ;;
esac
