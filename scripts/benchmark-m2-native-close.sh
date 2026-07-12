#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-all}"
IDENTIFIER="dev.tunara.m2nativeclosebenchmark"
PRODUCT_NAME="Tunara M2 Native Close Benchmark"
APP_DIR="$ROOT/src-tauri/target/release/bundle/macos/$PRODUCT_NAME.app"
APP_BIN="$APP_DIR/Contents/MacOS/tunara"
APP_SUPPORT="$HOME/Library/Application Support/$IDENTIFIER"
STORE="$APP_SUPPORT/tunara-sessions.json"
RESULTS_ROOT="${TUNARA_M2_NATIVE_CLOSE_RESULTS:-/tmp/tunara-m2-native-close-results}"
WAIT_SECONDS="${TUNARA_M2_NATIVE_CLOSE_WAIT_SECONDS:-90}"
fixture="/tmp/tunara-m2-native-close-$(date -u +%Y%m%dT%H%M%SZ)-$$"

stop_bundle() { pkill -f "$APP_BIN" 2>/dev/null || true; }
cleanup() { rm -rf "$fixture"; }

build_bundle() {
  cd "$ROOT"
  VITE_TUNARA_BENCHMARK=m2-native-close pnpm tauri build --bundles app --config \
    "{\"identifier\":\"$IDENTIFIER\",\"productName\":\"$PRODUCT_NAME\"}"
}

wait_marker() {
  local marker="$1" log="$2"
  for _ in $(seq 1 "$((WAIT_SECONDS * 4))"); do
    grep -F "[benchmark:m2-native-close:$marker]" "$log" >/dev/null && return 0
    sleep 0.25
  done
  return 1
}

press_native_close() {
  osascript - "$PRODUCT_NAME" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    tell process (item 1 of argv)
      set frontmost to true
      perform action "AXPress" of button 1 of window 1
    end tell
  end tell
end run
APPLESCRIPT
}

window_visible() {
  osascript - "$PRODUCT_NAME" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    tell process (item 1 of argv)
      return count of windows is greater than 0
    end tell
  end tell
end run
APPLESCRIPT
}

wait_store_stable_hash() {
  local previous current stable=0
  previous="$(shasum -a 256 "$STORE" | awk '{print $1}')"
  for _ in $(seq 1 40); do
    sleep 0.25
    current="$(shasum -a 256 "$STORE" | awk '{print $1}')"
    if [[ "$current" == "$previous" ]]; then
      stable=$((stable + 1))
      [[ "$stable" -ge 20 ]] && { printf '%s\n' "$current"; return 0; }
    else
      stable=0
      previous="$current"
    fi
  done
  return 1
}

write_fixture() {
  mkdir -p "$fixture" "$APP_SUPPORT"
  fixture="$(cd "$fixture" && pwd -P)"
  printf 'saved baseline\n' > "$fixture/draft.md"
  local now
  now="$(($(date +%s) * 1000))"
  jq -n --arg dir "$fixture" --argjson now "$now" '{workspaceSnapshot:{version:1,savedAt:$now,activeSessionId:"m2-native-close",sessions:[{id:"m2-native-close",title:"M2 Native Close",dir:$dir,branch:"",mascot:"otter",updatedAt:$now}],terminals:{},agentResume:{},recentDirs:[$dir],recentCommands:[],commandUsage:{},workflows:[],ui:{sidebarVisible:false,panelVisible:true,collapsedDirs:{},collapsedDiffSections:{},inspectorTab:"files",split:{mode:"single",paneA:null,paneB:null,ratio:0.5}}}}' > "$STORE"
}

run_benchmark() {
  [[ -x "$APP_BIN" ]] || { echo "Benchmark bundle is missing. Run: $0 build" >&2; exit 4; }
  stop_bundle
  trap cleanup EXIT
  write_fixture
  local stamp result_dir log pid baseline_hash cancel_hash discard_hash clean_hash visible_after_cancel visible_after_discard visible_after_reopen visible_after_clean file_content
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  result_dir="$RESULTS_ROOT/$stamp"
  log="$result_dir/app.log"
  mkdir -p "$result_dir"
  RUST_LOG=info "$APP_BIN" > "$log" 2>&1 &
  pid=$!
  trap "kill '$pid' 2>/dev/null || true; cleanup" EXIT
  wait_marker dirty-ready "$log" || { tail -100 "$log" >&2; exit 5; }
  # Startup opens the restored PTY and may legitimately finish a queued
  # workspace save. Establish an idle baseline before the native close so the
  # comparison measures only writes caused by the close path.
  baseline_hash="$(wait_store_stable_hash)"

  press_native_close
  wait_marker cancel-complete "$log" || { tail -100 "$log" >&2; exit 6; }
  cancel_hash="$(shasum -a 256 "$STORE" | awk '{print $1}')"
  visible_after_cancel="$(window_visible)"

  press_native_close
  wait_marker discard-complete "$log" || { tail -100 "$log" >&2; exit 7; }
  for _ in $(seq 1 40); do [[ "$(window_visible)" == "false" ]] && break; sleep 0.1; done
  visible_after_discard="$(window_visible)"
  discard_hash="$(shasum -a 256 "$STORE" | awk '{print $1}')"

  open "$APP_DIR"
  for _ in $(seq 1 40); do [[ "$(window_visible)" == "true" ]] && break; sleep 0.1; done
  visible_after_reopen="$(window_visible)"
  wait_marker clean-ready "$log" || { tail -100 "$log" >&2; exit 8; }
  press_native_close
  for _ in $(seq 1 40); do [[ "$(window_visible)" == "false" ]] && break; sleep 0.1; done
  visible_after_clean="$(window_visible)"
  clean_hash="$(shasum -a 256 "$STORE" | awk '{print $1}')"
  file_content="$(tr -d '\n' < "$fixture/draft.md")"

  jq -n \
    --arg baselineHash "$baseline_hash" --arg cancelHash "$cancel_hash" --arg discardHash "$discard_hash" --arg cleanHash "$clean_hash" \
    --argjson visibleAfterCancel "$visible_after_cancel" --argjson visibleAfterDiscard "$visible_after_discard" \
    --argjson visibleAfterReopen "$visible_after_reopen" --argjson visibleAfterClean "$visible_after_clean" --arg fileContent "$file_content" \
    --slurpfile cancel <(grep -F '[benchmark:m2-native-close:cancel-complete]' "$log" | tail -1 | sed 's/^.*\[benchmark:m2-native-close:cancel-complete\] //') \
    --slurpfile discard <(grep -F '[benchmark:m2-native-close:discard-complete]' "$log" | tail -1 | sed 's/^.*\[benchmark:m2-native-close:discard-complete\] //') \
    '{benchmark:"m2-native-close",nativeTrigger:"AXPress red close button",cancel:$cancel[0],discard:$discard[0],persistence:{baselineHash:$baselineHash,cancelHash:$cancelHash,discardHash:$discardHash,cleanHash:$cleanHash,unchangedBeforeConfirmation:($baselineHash==$cancelHash),advancedAfterDiscard:($discardHash!=$cancelHash),advancedOnCleanClose:($cleanHash!=$discardHash)},window:{visibleAfterCancel:$visibleAfterCancel,visibleAfterDiscard:$visibleAfterDiscard,visibleAfterReopen:$visibleAfterReopen,visibleAfterClean:$visibleAfterClean},fileContent:$fileContent,passed:($cancel[0].firstWarningVisible and $cancel[0].draftPreserved and $cancel[0].editorPreserved and $discard[0].secondWarningVisible and ($baselineHash==$cancelHash) and ($discardHash!=$cancelHash) and ($cleanHash!=$discardHash) and $visibleAfterCancel and ($visibleAfterDiscard|not) and $visibleAfterReopen and ($visibleAfterClean|not) and ($fileContent=="saved baseline"))}' > "$result_dir/result.json"
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
