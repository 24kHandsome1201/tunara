#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
IDENTIFIER="dev.tunara.m1benchmark"
PRODUCT_NAME="Tunara M1 Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
RESULTS_ROOT="${TUNARA_BENCHMARK_RESULTS:-/tmp/tunara-m1-output-benchmark}"
OUTPUT_BYTES="${TUNARA_M1_OUTPUT_BYTES:-52428800,209715200}"
WAIT_SECONDS="${TUNARA_M1_WAIT_SECONDS:-600}"

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || (( WAIT_SECONDS < 1 )); then
  echo "TUNARA_M1_WAIT_SECONDS must be a positive integer" >&2
  exit 2
fi

build_bundle() {
  local node
  node="$(command -v node)"
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m1-output \
  VITE_TUNARA_BENCHMARK_OUTPUT_BYTES="$OUTPUT_BYTES" \
  VITE_TUNARA_BENCHMARK_NODE="$node" \
  VITE_TUNARA_BENCHMARK_ROOT="$ROOT" \
    pnpm tauri build --bundles app --config \
      "{\"identifier\":\"$IDENTIFIER\",\"productName\":\"$PRODUCT_NAME\"}"
}

stop_bundle() {
  pkill -f "$APP_BIN" 2>/dev/null || true
}

write_fixture() {
  local branch now store
  branch="$(git -C "$ROOT" branch --show-current)"
  now="$(($(date +%s) * 1000))"
  store="$APP_SUPPORT/tunara-sessions.json"
  mkdir -p "$APP_SUPPORT"
  jq -n \
    --arg dir "$ROOT" \
    --arg branch "$branch" \
    --argjson now "$now" '
      def session($i): {
        id: ("m1-output-" + ($i | tostring)),
        title: (if $i == 0 then "高输出终端" else "输入对照终端" end),
        dir: $dir,
        branch: $branch,
        mascot: (if $i == 0 then "otter" else "panda" end),
        updatedAt: ($now + $i)
      };
      {
        workspaceSnapshot: {
          version: 1,
          savedAt: $now,
          activeSessionId: "m1-output-0",
          sessions: [session(0), session(1)],
          terminals: {},
          agentResume: {},
          recentDirs: [$dir],
          recentCommands: [],
          commandUsage: {},
          workflows: [],
          ui: {
            sidebarVisible: true,
            panelVisible: false,
            collapsedDirs: {},
            collapsedDiffSections: {},
            inspectorTab: "overview",
            split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 }
          }
        }
      }
    ' > "$store"
}

run_benchmark() {
  if ioreg -n Root -d1 | grep -F '"IOConsoleLocked" = Yes' >/dev/null; then
    echo "The macOS console is locked. Unlock it before running the frame benchmark." >&2
    exit 3
  fi
  if [[ ! -x "$APP_BIN" ]]; then
    echo "Benchmark bundle is missing. Run: $0 build" >&2
    exit 4
  fi

  stop_bundle
  write_fixture

  local stamp result_dir log samples done_file pid sample_pid line bundle_kib webkit_baseline
  local app_rss_peak renderer_rss_delta_peak pty_rss_peak total_rss_peak total_rss_mean cpu_mean
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp"
  log="$result_dir/app.log"
  samples="$result_dir/process-samples.csv"
  done_file="$result_dir/done"
  mkdir -p "$result_dir"

  ps -axo pid=,rss=,command= | awk '
    /\/com\.apple\.WebKit\.(GPU|Networking|WebContent)/ { print $1 "," $2 }
  ' | sort -n > "$result_dir/webkit-baseline.csv"
  webkit_baseline="$(awk -F, '{ printf "%s%s:%s", (NR > 1 ? "," : ""), $1, $2 }' "$result_dir/webkit-baseline.csv")"

  RUST_LOG=info "$APP_BIN" > "$log" 2>&1 &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT

  printf 'timestamp_ms,app_rss_kib,renderer_rss_delta_kib,pty_rss_kib,total_incremental_rss_kib,app_pty_cpu_percent\n' > "$samples"
  (
    while kill -0 "$pid" 2>/dev/null && [[ ! -e "$done_file" ]]; do
      ps -axo pid=,ppid=,rss=,%cpu=,command= | awk \
        -v ts="$(($(date +%s) * 1000))" \
        -v app_pid="$pid" \
        -v webkit_baseline="$webkit_baseline" '
          BEGIN {
            count = split(webkit_baseline, entries, ",")
            for (i = 1; i <= count; i++) {
              split(entries[i], pair, ":")
              baseline[pair[1]] = pair[2]
            }
          }
          $1 == app_pid { app_rss += $3; cpu += $4 }
          $2 == app_pid { pty_rss += $3; cpu += $4 }
          /\/com\.apple\.WebKit\.(GPU|Networking|WebContent)/ {
            delta = $3 - (baseline[$1] + 0)
            if (delta > 0) renderer_delta += delta
          }
          END {
            total = app_rss + renderer_delta + pty_rss
            print ts "," app_rss+0 "," renderer_delta+0 "," pty_rss+0 "," total+0 "," cpu+0
          }
        '
      sleep 0.25
    done
  ) >> "$samples" &
  sample_pid=$!

  line=""
  local wait_iterations
  wait_iterations="$((WAIT_SECONDS * 4))"
  for _ in $(seq 1 "$wait_iterations"); do
    line="$(grep -F '[benchmark:m1-output]' "$log" | tail -1 || true)"
    if [[ -n "$line" ]]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  touch "$done_file"
  wait "$sample_pid" || true

  if [[ -z "$line" ]]; then
    echo "Benchmark report was not emitted. See $log" >&2
    exit 5
  fi

  printf '%s\n' "$line" | sed 's/^.*\[benchmark:m1-output\] //' | jq . > "$result_dir/terminal.json"
  app_rss_peak="$(awk -F, 'NR > 1 && $2 > max { max=$2 } END { print max+0 }' "$samples")"
  renderer_rss_delta_peak="$(awk -F, 'NR > 1 && $3 > max { max=$3 } END { print max+0 }' "$samples")"
  pty_rss_peak="$(awk -F, 'NR > 1 && $4 > max { max=$4 } END { print max+0 }' "$samples")"
  total_rss_peak="$(awk -F, 'NR > 1 && $5 > max { max=$5 } END { print max+0 }' "$samples")"
  total_rss_mean="$(awk -F, 'NR > 1 { sum+=$5; n++ } END { if (n) printf "%.2f", sum/n; else print 0 }' "$samples")"
  cpu_mean="$(awk -F, 'NR > 1 { sum+=$6; n++ } END { if (n) printf "%.2f", sum/n; else print 0 }' "$samples")"
  bundle_kib="$(du -sk "$APP_DIR" | awk '{print $1}')"

  jq -n \
    --slurpfile terminal "$result_dir/terminal.json" \
    --arg commit "$(git -C "$ROOT" rev-parse HEAD)" \
    --arg macos "$(sw_vers -productVersion) ($(sw_vers -buildVersion))" \
    --arg hardware "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)" \
    --argjson pid "$pid" \
    --argjson appRssPeakKiB "$app_rss_peak" \
    --argjson rendererRssDeltaPeakKiB "$renderer_rss_delta_peak" \
    --argjson ptyRssPeakKiB "$pty_rss_peak" \
    --argjson totalRssPeakKiB "$total_rss_peak" \
    --argjson totalRssMeanKiB "$total_rss_mean" \
    --argjson cpuMeanPercent "$cpu_mean" \
    --argjson bundleKiB "$bundle_kib" '
      {
        commit: $commit,
        buildMode: "optimized release M1 benchmark bundle",
        macOS: $macos,
        hardware: $hardware,
        pid: $pid,
        process: {
          appRssPeakKiB: $appRssPeakKiB,
          rendererRssDeltaPeakKiB: $rendererRssDeltaPeakKiB,
          ptyRssPeakKiB: $ptyRssPeakKiB,
          totalIncrementalRssPeakKiB: $totalRssPeakKiB,
          totalIncrementalRssMeanKiB: $totalRssMeanKiB,
          cpuMeanPercent: $cpuMeanPercent
        },
        bundleKiB: $bundleKiB,
        terminal: $terminal[0]
      }
    ' > "$result_dir/result.json"

  echo "Benchmark complete: $result_dir/result.json"
  echo "Raw samples: $samples"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  trap - EXIT
  if [[ "$(jq -r '.terminal.passed' "$result_dir/result.json")" != "true" ]]; then
    echo "Terminal output benchmark failed its correctness gate." >&2
    exit 6
  fi
}

case "$ACTION" in
  build) build_bundle ;;
  run) run_benchmark ;;
  stop) stop_bundle ;;
  all) build_bundle; run_benchmark ;;
  *)
    echo "Usage: $0 [all|build|run|stop]" >&2
    exit 2
    ;;
esac
