#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: smoke-codex-semantics.sh OUTPUT_PREFIX COMMAND_STRING" >&2
  exit 2
fi

prefix="$1"
command_string="$2"
session="tunara-codex-semantic-$$"
buffer="tunara-codex-semantic-$$"

cleanup() {
  tmux kill-session -t "$session" >/dev/null 2>&1 || true
  tmux delete-buffer -b "$buffer" >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
  local stage="$1"
  tmux capture-pane -p -e -t "$session" > "$prefix.$stage.log"
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
  for ((i = 0; i < 80; i += 1)); do
    screen="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
    if grep -q 'OpenAI Codex' <<< "$screen" \
      && grep -Eq '^[›>] ' <<< "$screen" \
      && ! grep -Eq 'Booting MCP|Starting MCP servers' <<< "$screen"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

tmux new-session -d -s "$session" -x 120 -y 40 "$command_string"

trust_denied=0
if wait_for_text 'Hooks need review|OpenAI Codex' 60; then
  screen="$(tmux capture-pane -p -t "$session")"
  if grep -q 'Hooks need review' <<< "$screen"; then
    tmux send-keys -t "$session" Down Down Enter
    trust_denied=1
  fi
fi

if ! wait_for_ready; then
  capture startup-failure
  printf 'ready=0 trust_denied=%s normal_exit=0\n' "$trust_denied" > "$prefix.result"
  exit 0
fi

capture baseline

tmux send-keys -t "$session" '/'
if ! wait_for_text '^  /permissions' 20; then
  tmux send-keys -t "$session" C-c
  sleep 0.5
  tmux send-keys -t "$session" '/'
  wait_for_text '^  /permissions' 20 || true
fi
capture slash-menu
tmux send-keys -t "$session" 'perm'
wait_for_text '^[›>] /perm$' 20 || true
capture slash-filter
tmux send-keys -t "$session" C-c
sleep 1
capture slash-cancel

tmux send-keys -t "$session" C-r
sleep 1
capture history
tmux send-keys -t "$session" Escape
sleep 1
capture history-cancel

tmux set-buffer -b "$buffer" $'TUNARA_CODEX_SEMANTIC_A\nTUNARA_CODEX_SEMANTIC_B'
tmux paste-buffer -p -b "$buffer" -t "$session"
sleep 1
capture multiline
tmux send-keys -t "$session" C-c
sleep 1
capture multiline-cancel

tmux send-keys -t "$session" C-d
sleep 1
if tmux has-session -t "$session" 2>/dev/null; then
  tmux send-keys -t "$session" C-d
  sleep 1
fi

normal_exit=0
if ! tmux has-session -t "$session" 2>/dev/null; then
  normal_exit=1
fi
printf 'ready=1 trust_denied=%s normal_exit=%s\n' "$trust_denied" "$normal_exit" > "$prefix.result"
