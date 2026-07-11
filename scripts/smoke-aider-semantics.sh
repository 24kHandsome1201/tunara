#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: smoke-aider-semantics.sh OUTPUT_PREFIX COMMAND_STRING" >&2
  exit 2
fi

prefix="$1"
command_string="$2"
if [[ "$command_string" != *"aider-isolated-probe.sh"* ]]; then
  echo "refusing probe without isolated Aider environment" >&2
  exit 2
fi
session="tunara-aider-semantic-$$"
buffer="tunara-aider-semantic-$$"

cleanup() {
  tmux kill-session -t "$session" >/dev/null 2>&1 || true
  tmux delete-buffer -b "$buffer" >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
  tmux capture-pane -p -e -t "$session" > "$prefix.$1.log"
}

capture_scrollback() {
  tmux capture-pane -p -e -S -240 -t "$session" > "$prefix.$1.log"
}

screen() {
  tmux capture-pane -p -t "$session" 2>/dev/null || true
}

wait_for_text() {
  local pattern="$1"
  local attempts="${2:-60}"
  for ((i = 0; i < attempts; i += 1)); do
    if screen | grep -Eq "$pattern"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

tmux new-session -d -s "$session" -x 120 -y 40 "$command_string"
for ((i = 0; i < 80; i += 1)); do
  current="$(screen)"
  if grep -q "Would you like to see what's new" <<< "$current"; then
    tmux send-keys -t "$session" n Enter
    break
  fi
  if grep -Eq '^>\s*$' <<< "$current"; then
    break
  fi
  sleep 0.25
done
if ! wait_for_text '^>\s*$' 80; then
  capture startup-failure
  printf 'ready=0 normal_exit=0\n' > "$prefix.result"
  exit 0
fi
capture baseline

tmux send-keys -t "$session" '/'
wait_for_text '/settings' 20 || true
capture slash-menu
tmux send-keys -t "$session" 'sett'
wait_for_text '^\s*/settings\s*$' 20 || true
capture slash-filter
tmux send-keys -t "$session" C-c
sleep 0.5
capture slash-cancel

tmux send-keys -t "$session" '/settings' Tab Enter
wait_for_text 'Main model \(openai/gpt-4o-mini\)' 40 || true
capture_scrollback settings-output
tmux send-keys -t "$session" C-Up
sleep 0.5
capture history-up
tmux send-keys -t "$session" C-Down
sleep 0.5
capture history-down

tmux set-buffer -b "$buffer" $'TUNARA_AIDER_SEMANTIC_A\nTUNARA_AIDER_SEMANTIC_B'
tmux paste-buffer -p -b "$buffer" -t "$session"
sleep 0.5
capture multiline
tmux send-keys -t "$session" C-c
sleep 0.5
capture multiline-cancel

tmux send-keys -t "$session" '/exit' Tab Enter
normal_exit=0
for ((i = 0; i < 20; i += 1)); do
  if ! tmux has-session -t "$session" 2>/dev/null; then
    normal_exit=1
    break
  fi
  sleep 0.25
done
printf 'ready=1 normal_exit=%s\n' "$normal_exit" > "$prefix.result"
