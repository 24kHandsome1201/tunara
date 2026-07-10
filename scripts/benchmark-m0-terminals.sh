#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
COUNT="${TUNARA_BENCHMARK_TERMINALS:-12}"
IDENTIFIER="dev.tunara.m0benchmark"
PRODUCT_NAME="Tunara M0 Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
RESULTS_ROOT="${TUNARA_BENCHMARK_RESULTS:-/tmp/tunara-m0-benchmark}"

if [[ "$COUNT" -lt 10 ]]; then
  echo "TUNARA_BENCHMARK_TERMINALS must be at least 10" >&2
  exit 2
fi

build_bundle() {
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m0 pnpm tauri build --bundles app --config \
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
    --argjson count "$COUNT" \
    --argjson now "$now" '
      def session($i): {
        id: ("m0-bench-" + ($i | tostring)),
        title: ("基线终端 " + (($i + 1) | tostring)),
        dir: $dir,
        branch: $branch,
        mascot: (["cat", "dog", "fox", "panda", "hamster", "frog", "koala", "penguin", "rabbit", "otter", "raccoon", "owl"][$i % 12]),
        updatedAt: ($now + $i)
      };
      {
        workspaceSnapshot: {
          version: 1,
          savedAt: $now,
          activeSessionId: "m0-bench-0",
          sessions: [range(0; $count) | session(.)],
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
            inspectorTab: "overview",
            split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 }
          }
        }
      }
    ' > "$store"
}

run_benchmark() {
  # Do not use `grep -q` here under pipefail: its early exit SIGPIPEs ioreg and
  # makes the whole pipeline look false even when the console is locked.
  if ioreg -n Root -d1 | grep -F '"IOConsoleLocked" = Yes' >/dev/null; then
    echo "The macOS console is locked. Unlock it before running the frame baseline." >&2
    exit 3
  fi
  if [[ ! -x "$APP_BIN" ]]; then
    echo "Benchmark bundle is missing. Run: $0 build" >&2
    exit 4
  fi

  stop_bundle
  write_fixture

  local stamp result_dir log samples pid sample_pid line bundle_kib webkit_baseline
  local app_rss_peak renderer_rss_delta_peak pty_rss_peak total_rss_peak total_rss_mean cpu_mean
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp"
  log="$result_dir/app.log"
  samples="$result_dir/process-samples.csv"
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
    # Twenty seconds covers cold mount plus a stable idle tail without turning
    # a quick acceptance gate into a minute-long wait.
    for _ in $(seq 1 80); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
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
  for _ in $(seq 1 180); do
    line="$(grep -F '[benchmark:m0]' "$log" | tail -1 || true)"
    if [[ -n "$line" ]]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  wait "$sample_pid" || true

  if [[ -z "$line" ]]; then
    echo "Benchmark report was not emitted. See $log" >&2
    exit 5
  fi

  printf '%s\n' "$line" | sed 's/^.*\[benchmark:m0\] //' | jq . > "$result_dir/terminal.json"
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
    --argjson terminalCount "$COUNT" \
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
        buildMode: "optimized release benchmark bundle",
        macOS: $macos,
        hardware: $hardware,
        requestedTerminals: $terminalCount,
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
  echo "The isolated benchmark app has been stopped."
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
