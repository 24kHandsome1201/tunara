#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCHMARK="$ROOT/scripts/benchmark-m1-terminal-output.sh"
APP_BIN="$ROOT/src-tauri/target/release/bundle/macos/Tunara M1 Benchmark.app/Contents/MacOS/tunara"
CHUNK_BYTES="${TUNARA_M1_STRESS_CHUNK_BYTES:-268435456}"
CHUNKS="${TUNARA_M1_STRESS_CHUNKS:-56}"
WAIT_SECONDS="${TUNARA_M1_WAIT_SECONDS:-2700}"
RESIZE_INTERVAL_SECONDS="${TUNARA_M1_RESIZE_INTERVAL_SECONDS:-15}"

if ! [[ "$CHUNK_BYTES" =~ ^[0-9]+$ ]] || (( CHUNK_BYTES < 1048576 )); then
  echo "TUNARA_M1_STRESS_CHUNK_BYTES must be at least 1 MiB" >&2
  exit 2
fi
if ! [[ "$CHUNKS" =~ ^[0-9]+$ ]] || (( CHUNKS < 1 )); then
  echo "TUNARA_M1_STRESS_CHUNKS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || (( WAIT_SECONDS < 1 )); then
  echo "TUNARA_M1_WAIT_SECONDS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$RESIZE_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || (( RESIZE_INTERVAL_SECONDS < 1 )); then
  echo "TUNARA_M1_RESIZE_INTERVAL_SECONDS must be a positive integer" >&2
  exit 2
fi

EVENTS_FILE="$(mktemp "${TMPDIR:-/tmp}/tunara-m1-stress-events.XXXXXX")"
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/tunara-m1-stress-run.XXXXXX")"

output_sizes=""
for _ in $(seq 1 "$CHUNKS"); do
  output_sizes="${output_sizes:+$output_sizes,}$CHUNK_BYTES"
done
printf 'timestamp,pid,event,width,height\n' > "$EVENTS_FILE"

exercise_window() {
  local pid=""
  for _ in $(seq 1 240); do
    pid="$(pgrep -f "$APP_BIN" | head -1 || true)"
    [[ -n "$pid" ]] && break
    sleep 0.25
  done
  [[ -n "$pid" ]] || return 0

  local index=0
  local sizes=("720 520" "1040 680" "820 600" "1180 760")
  while kill -0 "$pid" 2>/dev/null; do
    read -r width height <<< "${sizes[$((index % ${#sizes[@]}))]}"
    if osascript \
      -e 'tell application "System Events"' \
      -e "tell first process whose unix id is $pid" \
      -e 'set visible to true' \
      -e "set size of window 1 to {$width, $height}" \
      -e 'end tell' \
      -e 'end tell' >/dev/null 2>&1; then
      printf '%s,%s,resize,%s,%s\n' "$(date -u +%FT%TZ)" "$pid" "$width" "$height" >> "$EVENTS_FILE"
    else
      printf '%s,%s,resize-failed,%s,%s\n' "$(date -u +%FT%TZ)" "$pid" "$width" "$height" >> "$EVENTS_FILE"
    fi

    if (( index > 0 && index % 8 == 0 )); then
      if osascript \
        -e 'tell application "System Events"' \
        -e "tell first process whose unix id is $pid to set visible to false" \
        -e 'end tell' >/dev/null 2>&1; then
        printf '%s,%s,hide,,\n' "$(date -u +%FT%TZ)" "$pid" >> "$EVENTS_FILE"
      else
        printf '%s,%s,hide-failed,,\n' "$(date -u +%FT%TZ)" "$pid" >> "$EVENTS_FILE"
      fi
      sleep 5
      if osascript \
        -e 'tell application "System Events"' \
        -e "tell first process whose unix id is $pid to set visible to true" \
        -e 'end tell' >/dev/null 2>&1; then
        printf '%s,%s,show,,\n' "$(date -u +%FT%TZ)" "$pid" >> "$EVENTS_FILE"
      else
        printf '%s,%s,show-failed,,\n' "$(date -u +%FT%TZ)" "$pid" >> "$EVENTS_FILE"
      fi
    fi

    index=$((index + 1))
    sleep "$RESIZE_INTERVAL_SECONDS"
  done
}

TUNARA_M1_OUTPUT_BYTES="$output_sizes" \
TUNARA_M1_WAIT_SECONDS="$WAIT_SECONDS" \
  "$BENCHMARK" build

exercise_window &
stimulus_pid=$!
trap 'kill "$stimulus_pid" 2>/dev/null || true; rm -f "$EVENTS_FILE" "$RUN_LOG"' EXIT

TUNARA_M1_WAIT_SECONDS="$WAIT_SECONDS" "$BENCHMARK" run | tee "$RUN_LOG"

wait "$stimulus_pid" 2>/dev/null || true
result_path="$(awk '/^Benchmark complete: / { print $3 }' "$RUN_LOG" | tail -1)"
if [[ -n "$result_path" && -f "$result_path" ]]; then
  cp "$EVENTS_FILE" "$(dirname "$result_path")/stress-events.csv"
  echo "Stress window events: $(dirname "$result_path")/stress-events.csv"
fi
rm -f "$EVENTS_FILE" "$RUN_LOG"
trap - EXIT
