#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: smoke-opencode-semantics.sh OUTPUT_PREFIX COMMAND_STRING" >&2
  exit 2
fi

prefix="$1"
command_string="$2"
if [[ "$command_string" != *"opencode-loopback-probe.sh"* ]]; then
  echo "refusing probe without loopback provider and disabled tools" >&2
  exit 2
fi
session="tunara-opencode-semantic-$$"
buffer="tunara-opencode-semantic-$$"

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

wait_for_ready() {
  local screen
  for ((i = 0; i < 100; i += 1)); do
    screen="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
    if grep -q 'Ask anything' <<< "$screen" && grep -q '1.17.18' <<< "$screen"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_filter() {
  local screen
  for ((i = 0; i < 40; i += 1)); do
    screen="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
    if grep -Eq '/mo\s*$' <<< "$screen" && ! grep -q '/agents' <<< "$screen"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

tmux new-session -d -s "$session" -x 120 -y 40 "$command_string"
if ! wait_for_ready; then
  capture startup-failure
  printf 'ready=0 normal_exit=0\n' > "$prefix.result"
  exit 0
fi
capture baseline

tmux send-keys -t "$session" '/'
wait_for_text '/agents.*Switch agent' 20 || true
capture slash-menu
tmux send-keys -t "$session" 'mo'
wait_for_filter || true
capture slash-filter
tmux send-keys -t "$session" Escape
sleep 0.5
capture slash-cancel

tmux set-buffer -b "$buffer" $'TUNARA_OPENCODE_SEMANTIC_A\nTUNARA_OPENCODE_SEMANTIC_B'
tmux paste-buffer -p -b "$buffer" -t "$session"
sleep 0.5
capture multiline
tmux send-keys -t "$session" C-c
sleep 0.5
capture multiline-cancel

# The caller must bind this probe to a loopback-only provider stub. A 401 ends
# the turn deterministically, creates real composer history, and cannot reach a
# model or external network.
tmux send-keys -t "$session" 'TUNARA_OPENCODE_HISTORY_SEED' Enter
wait_for_text 'Unauthorized' 40 || true
sleep 0.5
capture history-failure
tmux send-keys -t "$session" Up
sleep 0.5
capture history-up
tmux send-keys -t "$session" C-c
sleep 0.5
capture history-cancel

tmux send-keys -t "$session" '/exit' Enter
sleep 0.5
if tmux has-session -t "$session" 2>/dev/null; then
  # OpenCode may use the first Return to accept the exact autocomplete item.
  tmux send-keys -t "$session" Enter
fi
normal_exit=0
for ((i = 0; i < 20; i += 1)); do
  if ! tmux has-session -t "$session" 2>/dev/null; then
    normal_exit=1
    break
  fi
  sleep 0.25
done
printf 'ready=1 normal_exit=%s\n' "$normal_exit" > "$prefix.result"
