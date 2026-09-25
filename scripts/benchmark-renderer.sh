#!/usr/bin/env bash
# Pre-release renderer benchmark: builds the same commit twice, once pinned to
# WebGL and once pinned to the DOM renderer, floods one pane with the mixed
# CJK/Latin/ANSI fixture for throughput and all four panes at once for frame
# time, then prints the comparison table for the release notes / PR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
RENDERERS="${TUNARA_RENDERER_BENCHMARK_MODES:-webgl dom}"
RESULTS_ROOT="${TUNARA_BENCHMARK_RESULTS:-/tmp/tunara-renderer-benchmark}"
OUTPUT_BYTES="${TUNARA_RENDERER_OUTPUT_BYTES:-52428800}"
PANE_BYTES="${TUNARA_RENDERER_PANE_BYTES:-8388608}"
WAIT_SECONDS="${TUNARA_RENDERER_WAIT_SECONDS:-600}"
BENCHMARK_NODE="${TUNARA_BENCHMARK_NODE:-$(command -v node)}"
FIXTURE_PATH="${TUNARA_BENCHMARK_FIXTURE_PATH:-$ROOT/scripts/terminal-output-fixture.mjs}"

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || (( WAIT_SECONDS < 1 )); then
  echo "TUNARA_RENDERER_WAIT_SECONDS must be a positive integer" >&2
  exit 2
fi
for renderer in $RENDERERS; do
  if [[ "$renderer" != "webgl" && "$renderer" != "dom" ]]; then
    echo "TUNARA_RENDERER_BENCHMARK_MODES entries must be webgl or dom" >&2
    exit 2
  fi
done

identifier() { echo "dev.tunara.rendererbenchmark.$1"; }
product_name() { echo "Tunara Renderer Benchmark $1"; }
app_dir() { echo "$ROOT/src-tauri/target/release/bundle/macos/$(product_name "$1").app"; }
app_bin() { echo "$(app_dir "$1")/Contents/MacOS/tunara"; }
app_support() { echo "$HOME/Library/Application Support/$(identifier "$1")"; }

build_bundle() {
  local renderer="$1"
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=renderer \
  VITE_TUNARA_BENCHMARK_RENDERER="$renderer" \
  VITE_TUNARA_BENCHMARK_OUTPUT_BYTES="$OUTPUT_BYTES" \
  VITE_TUNARA_BENCHMARK_PANE_BYTES="$PANE_BYTES" \
  VITE_TUNARA_BENCHMARK_NODE="$BENCHMARK_NODE" \
  VITE_TUNARA_BENCHMARK_FIXTURE_PATH="$FIXTURE_PATH" \
  VITE_TUNARA_BENCHMARK_ROOT="$ROOT" \
    pnpm tauri build --bundles app --config \
      "{\"identifier\":\"$(identifier "$renderer")\",\"productName\":\"$(product_name "$renderer")\"}"
}

stop_bundle() {
  for renderer in $RENDERERS; do
    pkill -f "$(app_bin "$renderer")" 2>/dev/null || true
  done
}

write_fixture() {
  local renderer="$1" branch now support
  branch="$(git -C "$ROOT" branch --show-current)"
  now="$(($(date +%s) * 1000))"
  support="$(app_support "$renderer")"
  mkdir -p "$support"
  jq -n \
    --arg dir "$ROOT" \
    --arg branch "$branch" \
    --argjson now "$now" '
      def session($i): {
        id: ("renderer-pane-" + ($i | tostring)),
        title: ("渲染基准窗格 " + ($i + 1 | tostring)),
        dir: $dir,
        branch: $branch,
        updatedAt: ($now + $i)
      };
      {
        workspaceSnapshot: {
          version: 1,
          savedAt: $now,
          activeSessionId: "renderer-pane-0",
          sessions: [session(0), session(1), session(2), session(3)],
          terminals: {},
          agentResume: {},
          recentDirs: [$dir],
          recentCommands: [],
          commandUsage: {},
          workflows: [],
          ui: {
            sidebarVisible: false,
            panelVisible: false,
            collapsedDirs: {},
            collapsedDiffSections: {},
            inspectorTab: "overview",
            split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 }
          }
        }
      }
    ' > "$support/tunara-sessions.json"
}

run_benchmark() {
  local renderer="$1" bin stamp result_dir log line pid
  bin="$(app_bin "$renderer")"
  if ioreg -n Root -d1 | grep -F '"IOConsoleLocked" = Yes' >/dev/null; then
    echo "The macOS console is locked. Unlock it before running the frame benchmark." >&2
    exit 3
  fi
  if [[ ! -x "$bin" ]]; then
    echo "Benchmark bundle for $renderer is missing. Run: $0 build" >&2
    exit 4
  fi

  pkill -f "$bin" 2>/dev/null || true
  write_fixture "$renderer"

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp-$renderer"
  log="$result_dir/app.log"
  mkdir -p "$result_dir"

  RUST_LOG=info "$bin" > "$log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT

  line=""
  for _ in $(seq 1 "$((WAIT_SECONDS * 4))"); do
    line="$(grep -F '[benchmark:renderer]' "$log" | tail -1 || true)"
    if [[ -n "$line" ]]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.25
  done

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  trap - EXIT

  if [[ -z "$line" ]]; then
    echo "Benchmark report was not emitted. See $log" >&2
    exit 5
  fi

  printf '%s\n' "$line" | sed 's/^.*\[benchmark:renderer\] //' | jq . > "$result_dir/terminal.json"
  jq -n \
    --slurpfile terminal "$result_dir/terminal.json" \
    --arg commit "$(git -C "$ROOT" rev-parse HEAD)" \
    --arg macos "$(sw_vers -productVersion) ($(sw_vers -buildVersion))" \
    --arg hardware "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)" \
    --arg renderer "$renderer" '
      {
        commit: $commit,
        renderer: $renderer,
        buildMode: "optimized release renderer benchmark bundle",
        macOS: $macos,
        hardware: $hardware,
        terminal: $terminal[0]
      }
    ' > "$result_dir/result.json"
  ln -sfn "$result_dir/result.json" "$RESULTS_ROOT/latest-$renderer.json"
  echo "Benchmark ($renderer) complete: $result_dir/result.json"
  if [[ "$(jq -r '.terminal.correct' "$result_dir/result.json")" != "true" ]]; then
    echo "Renderer benchmark ($renderer) failed its correctness gate." >&2
    exit 6
  fi
  if [[ "$(jq -r '.terminal.passed' "$result_dir/result.json")" != "true" ]]; then
    echo "Renderer benchmark ($renderer) exceeded the 4-pane frame p95 budget." >&2
    BUDGET_MISSED=1
  fi
}

BUDGET_MISSED=0
finish() {
  if (( BUDGET_MISSED )); then
    echo "At least one renderer exceeded the frame budget; see the comparison table." >&2
    exit 7
  fi
}

compare() {
  local webgl="$RESULTS_ROOT/latest-webgl.json" dom="$RESULTS_ROOT/latest-dom.json"
  if [[ ! -e "$webgl" || ! -e "$dom" ]]; then
    echo "Both renderer results are required for the comparison table." >&2
    exit 4
  fi
  cd "$ROOT"
  node --experimental-strip-types scripts/renderer-benchmark-compare.mjs "$webgl" "$dom" \
    | tee "$RESULTS_ROOT/comparison.md"
}

case "$ACTION" in
  build) for renderer in $RENDERERS; do build_bundle "$renderer"; done ;;
  run) for renderer in $RENDERERS; do run_benchmark "$renderer"; done; finish ;;
  compare) compare ;;
  stop) stop_bundle ;;
  all)
    for renderer in $RENDERERS; do build_bundle "$renderer"; done
    for renderer in $RENDERERS; do run_benchmark "$renderer"; done
    compare
    finish
    ;;
  *)
    echo "Usage: $0 [all|build|run|compare|stop]" >&2
    exit 2
    ;;
esac
