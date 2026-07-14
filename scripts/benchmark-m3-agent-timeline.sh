#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
IDENTIFIER="dev.tunara.m3timelinebenchmark"
PRODUCT_NAME="Tunara M3 Timeline Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
TARGET_DIR="$(cd "$ROOT/src-tauri/target" && pwd -P)"
APP_BIN_REAL="$TARGET_DIR/release/bundle/macos/$PRODUCT_NAME.app/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
RESULTS_ROOT="${TUNARA_M3_TIMELINE_RESULTS:-/tmp/tunara-m3-agent-timeline-results}"
CAPTURE_WAIT_SECONDS="${TUNARA_M3_CAPTURE_WAIT_SECONDS:-0}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RESULT_DIR="$RESULTS_ROOT/$STAMP"

stop_bundle() {
  pkill -f "$APP_BIN_REAL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    pgrep -f "$APP_BIN_REAL" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}
cleanup() { stop_bundle; rm -rf "$APP_SUPPORT"; }

repository_identity() {
  local common
  common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
  if [[ -d "$common" ]]; then common="$(cd "$common" && pwd -P)"; fi
  printf 'local:%s\n' "$common"
}

build_bundle() {
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m3-timeline pnpm tauri build --bundles app --config \
    "{\"identifier\":\"$IDENTIFIER\",\"productName\":\"$PRODUCT_NAME\",\"app\":{\"security\":{\"capabilities\":[\"default\",\"desktop-capability\",{\"identifier\":\"m3-timeline-benchmark\",\"windows\":[\"main\"],\"permissions\":[\"core:window:allow-inner-size\",\"core:window:allow-set-min-size\",\"core:window:allow-set-size\"]}]}}}"
}

write_fixtures() {
  rm -rf "$APP_SUPPORT"
  mkdir -p "$APP_SUPPORT"
  local now identity branch
  now="$(($(date +%s) * 1000))"
  identity="$(repository_identity)"
  branch="$(git -C "$ROOT" branch --show-current)"
  node "$ROOT/scripts/agent-timeline-fixture.mjs" "$APP_SUPPORT/agent-events" "$identity" 10000 > "$RESULT_DIR/fixture-summary.json"
  jq -n --arg root "$ROOT" --arg branch "$branch" --argjson now "$now" '{
    workspaceSnapshot: {
      version: 1, savedAt: $now, activeSessionId: "m3-timeline-a",
      sessions: [
        { id: "m3-timeline-a", title: "构建 optimized release · main worktree · a-very-long-session-name", dir: $root, branch: $branch, updatedAt: $now },
        { id: "m3-timeline-b", title: "Review streaming append · 第二任务 · long-session-name", dir: $root, branch: $branch, updatedAt: $now }
      ],
      terminals: {}, agentResume: {}, recentDirs: [$root], recentCommands: [], commandUsage: {}, workflows: [],
      ui: { sidebarVisible: false, panelVisible: true, collapsedDirs: {}, collapsedDiffSections: {}, inspectorTab: "timeline", split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } }
    }
  }' > "$APP_SUPPORT/tunara-sessions.json"
}

run_once() {
  local ordinal="$1" log="$RESULT_DIR/app-$1.log" pid line rss
  RUST_LOG=info "$APP_BIN" > "$log" 2>&1 &
  pid=$!
  # LaunchServices activation keeps WKWebView frame scheduling in the foreground
  # while stdout remains attached to the directly launched benchmark process.
  for _ in $(seq 1 80); do
    grep -F 'main window restored during ready' "$log" >/dev/null 2>&1 && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  open "$APP_DIR" >/dev/null 2>&1 || true
  line=""
  for _ in $(seq 1 1200); do
    line="$(grep -F '[benchmark:m3-timeline]' "$log" | tail -1 || true)"
    [[ -n "$line" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  [[ -n "$line" ]] || { tail -120 "$log" >&2 || true; return 5; }
  printf '%s\n' "$line" | sed 's/^.*\[benchmark:m3-timeline\] //' | jq . > "$RESULT_DIR/gui-$ordinal.json"
  rss="$(ps -o rss= -p "$pid" | tr -d '[:space:]')"
  jq -n --argjson rssKiB "${rss:-0}" --argjson ordinal "$ordinal" '{ordinal: $ordinal, rssKiB: $rssKiB}' > "$RESULT_DIR/process-$ordinal.json"
  jq -s '.[0] + {process: .[1]}' "$RESULT_DIR/gui-$ordinal.json" "$RESULT_DIR/process-$ordinal.json" > "$RESULT_DIR/run-$ordinal.json"
  if [[ "$ordinal" == "2" && "$CAPTURE_WAIT_SECONDS" -gt 0 ]]; then
    printf 'M3_TIMELINE_CAPTURE_READY pid=%s seconds=%s result=%s\n' "$pid" "$CAPTURE_WAIT_SECONDS" "$RESULT_DIR"
    sleep "$CAPTURE_WAIT_SECONDS"
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

run_benchmark() {
  [[ -x "$APP_BIN" ]] || { echo "Benchmark bundle missing, run build first" >&2; exit 4; }
  mkdir -p "$RESULT_DIR"
  stop_bundle
  trap cleanup EXIT
  write_fixtures
  run_once 1
  run_once 2
  jq -s '{firstRun: .[0], restartRun: .[1], restartRecovered: (.[1].initial.retained == 100), passed: (.[0].passed and .[1].passed and .[1].initial.retained == 100)}' "$RESULT_DIR/run-1.json" "$RESULT_DIR/run-2.json" > "$RESULT_DIR/result.json"
  jq . "$RESULT_DIR/result.json"
  jq -e '.passed == true' "$RESULT_DIR/result.json" >/dev/null
}

case "$ACTION" in
  build) build_bundle ;;
  run) run_benchmark ;;
  all) build_bundle; run_benchmark ;;
  stop) stop_bundle ;;
  *) echo "Usage: $0 [build|run|all|stop]" >&2; exit 2 ;;
esac
