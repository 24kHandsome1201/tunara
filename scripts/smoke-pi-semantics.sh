#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: smoke-pi-semantics.sh OUTPUT_PREFIX COMMAND_STRING" >&2
  exit 2
fi

prefix="$1"
command_string="$2"
session="tunara-pi-semantic-$$"
buffer="tunara-pi-semantic-$$"

cleanup() {
  tmux kill-session -t "$session" >/dev/null 2>&1 || true
  tmux delete-buffer -b "$buffer" >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
  tmux capture-pane -p -e -t "$session" > "$prefix.$1.log"
}

wait_for_text() {
  local pattern="$1"
  local attempts="${2:-40}"
  local screen
  for ((i = 0; i < attempts; i += 1)); do
    screen="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
    if grep -Eq "$pattern" <<< "$screen"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

tmux new-session -d -s "$session" -x 120 -y 40 "$command_string"

if ! wait_for_text 'pi v[0-9]+\.|No models available' 80; then
  capture startup-failure
  printf 'ready=0 normal_exit=0\n' > "$prefix.result"
  exit 0
fi
capture baseline

tmux send-keys -t "$session" '/'
wait_for_text 'Open settings menu' 20 || true
capture slash-menu
tmux send-keys -t "$session" 'mod'
wait_for_text '^/mod$' 20 || true
capture slash-filter
tmux send-keys -t "$session" C-c
sleep 0.5
capture slash-cancel

# Double bang keeps the deterministic shell command out of model context while
# still creating a real entry in Pi's session-scoped prompt history.
tmux send-keys -t "$session" '!!printf TUNARA_PI_HISTORY_SEED'
tmux send-keys -t "$session" Enter
wait_for_text 'TUNARA_PI_HISTORY_SEED' 20 || true
sleep 0.5
tmux send-keys -t "$session" Up
sleep 0.5
capture history-up
tmux send-keys -t "$session" Down
sleep 0.5
capture history-down

tmux set-buffer -b "$buffer" $'TUNARA_PI_SEMANTIC_A\nTUNARA_PI_SEMANTIC_B'
tmux paste-buffer -p -b "$buffer" -t "$session"
sleep 0.5
capture multiline
tmux send-keys -t "$session" C-c
sleep 0.5
capture multiline-cancel

tmux send-keys -t "$session" C-d
sleep 1
normal_exit=0
if ! tmux has-session -t "$session" 2>/dev/null; then
  normal_exit=1
fi
printf 'ready=1 normal_exit=%s\n' "$normal_exit" > "$prefix.result"
