#!/usr/bin/env bash
set -u

# Runs on the configured SSH benchmark target. Keep every Aider artifact in a
# dedicated /tmp directory so this probe cannot create .aider* files in a
# remote project or in the remote user's home directory.
work="$(mktemp -d /tmp/tunara-aider-resume.XXXXXXXX)"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

common=(
  --model openai/gpt-4o-mini
  --no-git
  --no-auto-commits
  --no-check-update
  --analytics-disable
  --no-show-release-notes
  --no-show-model-warnings
  --no-detect-urls
  --no-suggest-shell-commands
  --no-pretty
  --no-stream
  --chat-history-file "$work/chat.md"
  --input-history-file "$work/input.history"
  --llm-history-file "$work/llm.history"
)

# bash -s and Aider otherwise share stdin; /dev/null prevents Aider from
# consuming the remainder of this probe script as chat input.
timeout 120 aider "${common[@]}" \
  --message 'Remember token TUNARA_AIDER_CONTEXT_4173 and reply exactly TUNARA_AIDER_FIRST_OK.' \
  < /dev/null > "$work/first.log" 2>&1
first_status=$?

timeout 120 aider "${common[@]}" --restore-chat-history \
  --message 'If the remembered token is TUNARA_AIDER_CONTEXT_4173, reply exactly TUNARA_AIDER_RESUME_OK.' \
  < /dev/null > "$work/resume.log" 2>&1
resume_status=$?

python3 - "$work" "$first_status" "$resume_status" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
first = (root / "first.log").read_text(errors="replace")
resume = (root / "resume.log").read_text(errors="replace")
chat_path = root / "chat.md"
chat = chat_path.read_text(errors="replace") if chat_path.exists() else ""

def classify(raw: str, status: int) -> str | None:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw).lower()
    if status in (124, 137) or "timed out" in text or "timeout" in text:
        return "timeout"
    if "authenticationerror" in text or "not able to authenticate" in text or "api key" in text:
        return "missing_or_invalid_api_key"
    if "rate limit" in text:
        return "rate_limit"
    if "error" in text:
        return "provider_or_cli_error"
    return None

first_marker = "TUNARA_AIDER_FIRST_OK" in first
resume_marker = "TUNARA_AIDER_RESUME_OK" in resume
history_identity = "TUNARA_AIDER_CONTEXT_4173" in chat
error_class = classify(first, int(sys.argv[2])) or classify(resume, int(sys.argv[3]))

print(json.dumps({
    "firstExit": int(sys.argv[2]),
    "resumeExit": int(sys.argv[3]),
    "firstMarkerObserved": first_marker,
    "resumeMarkerObserved": resume_marker,
    "historyIdentityObserved": history_identity,
    "chatHistoryBytes": len(chat.encode()),
    "errorClass": error_class,
    "passed": first_marker and resume_marker and history_identity and error_class is None,
}, ensure_ascii=False))
PY
