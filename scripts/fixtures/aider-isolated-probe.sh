#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: aider-isolated-probe.sh AIDER_COMMAND [ARGS...]" >&2
  exit 2
fi

runtime="/tmp/tunara-aider-probe-$$"
cleanup() {
  rm -rf "$runtime"
}
trap cleanup EXIT
mkdir -p "$runtime"

cd /tmp
env \
  OPENAI_API_KEY=tunara-probe-invalid \
  "$@" \
  --model openai/gpt-4o-mini \
  --no-git \
  --no-auto-commits \
  --no-show-model-warnings \
  --no-check-update \
  --no-analytics \
  --no-browser \
  --input-history-file "$runtime/input.history" \
  --chat-history-file "$runtime/chat.md" \
  --llm-history-file "$runtime/llm.history"
