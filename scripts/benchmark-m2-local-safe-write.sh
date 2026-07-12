#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
IDENTIFIER="dev.tunara.m2localbenchmark"
PRODUCT_NAME="Tunara M2 Local Safe Write Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
RESULTS_ROOT="${TUNARA_M2_LOCAL_RESULTS:-/tmp/tunara-m2-local-safe-write-benchmark-results}"
WAIT_SECONDS="${TUNARA_M2_WAIT_SECONDS:-180}"
nonce="$(date -u +%Y%m%dT%H%M%SZ)-$$"
fixture_a="/tmp/tunara-m2-local-safe-write-$nonce-a"
fixture_b="/tmp/tunara-m2-local-safe-write-$nonce-b"

stop_bundle() { pkill -f "$APP_BIN" 2>/dev/null || true; }
cleanup() { chmod 700 "$fixture_a" 2>/dev/null || true; rm -rf "$fixture_a" "$fixture_b"; }

build_bundle() {
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m2-local-safe-write pnpm tauri build --bundles app --config \
    "{\"identifier\":\"$IDENTIFIER\",\"productName\":\"$PRODUCT_NAME\"}"
}

write_fixtures() {
  mkdir -p "$fixture_a" "$fixture_b" "$APP_SUPPORT"
  # macOS exposes /tmp through /private/tmp. Local PTY cwd discovery returns
  # the physical path, so seed the workspace and GUI selectors with that same
  # identity instead of letting the benchmark drift after the first prompt.
  fixture_a="$(cd "$fixture_a" && pwd -P)"
  fixture_b="$(cd "$fixture_b" && pwd -P)"
  printf 'first\n' > "$fixture_a/first.md"
  printf 'second\n' > "$fixture_a/second.md"
  printf 'other-session\n' > "$fixture_b/other.md"
  chmod 700 "$fixture_a" "$fixture_b"
  local now store
  now="$(($(date +%s) * 1000))"
  store="$APP_SUPPORT/tunara-sessions.json"
  jq -n --arg a "$fixture_a" --arg b "$fixture_b" --argjson now "$now" '{
    workspaceSnapshot: {
      version: 1, savedAt: $now, activeSessionId: "m2-local-a",
      sessions: [
        { id: "m2-local-a", title: "M2 Local A", dir: $a, branch: "", mascot: "otter", updatedAt: $now },
        { id: "m2-local-b", title: "M2 Local B", dir: $b, branch: "", mascot: "panda", updatedAt: $now }
      ],
      terminals: {}, agentResume: {}, recentDirs: [$a, $b], recentCommands: [], commandUsage: {}, workflows: [],
      ui: { sidebarVisible: false, panelVisible: true, collapsedDirs: {}, collapsedDiffSections: {}, inspectorTab: "files", split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } }
    }
  }' > "$store"
}

run_benchmark() {
  if ioreg -n Root -d1 | grep -F '"IOConsoleLocked" = Yes' >/dev/null; then
    echo "The macOS console is locked. Unlock it before running the GUI benchmark." >&2; exit 3
  fi
  [[ -x "$APP_BIN" ]] || { echo "Benchmark bundle is missing. Run: $0 build" >&2; exit 4; }
  stop_bundle
  trap cleanup EXIT
  write_fixtures
  local stamp result_dir log pid line observed_content residue_count
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp"
  log="$result_dir/app.log"
  mkdir -p "$result_dir"
  RUST_LOG=info "$APP_BIN" > "$log" 2>&1 &
  pid=$!
  trap "kill '$pid' 2>/dev/null || true; cleanup" EXIT
  line=""
  for _ in $(seq 1 "$((WAIT_SECONDS * 4))"); do
    line="$(grep -F '[benchmark:m2-local-safe-write]' "$log" | tail -1 || true)"
    [[ -n "$line" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  [[ -n "$line" ]] || { echo "M2 local benchmark did not emit a result" >&2; tail -100 "$log" >&2 || true; exit 5; }
  printf '%s\n' "$line" | sed 's/^.*\[benchmark:m2-local-safe-write\] //' | jq . > "$result_dir/gui.json"
  observed_content="$(tr -d '\n' < "$fixture_a/first.md")"
  residue_count="$(find "$fixture_a" -maxdepth 1 -name '*.tunara-*.tmp' -print | wc -l | tr -d '[:space:]')"
  jq -n --arg content "$observed_content" --argjson residueCount "$residue_count" '{content: $content, residueCount: $residueCount, passed: ($content == "third" and $residueCount == 0)}' > "$result_dir/local.json"
  jq -s '.[0] + {independentLocal: .[1], passed: (.[0].passed and .[1].passed)}' "$result_dir/gui.json" "$result_dir/local.json" > "$result_dir/result.json"
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
