#!/usr/bin/env bash
set -u

work="$(mktemp -d /tmp/tunara-claude-resume.XXXXXXXX)"
session_id="66666666-6666-4666-8666-666666666666"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$work/config"

CLAUDE_CONFIG_DIR="$work/config" timeout 120 claude -p \
  --session-id "$session_id" \
  --permission-mode dontAsk \
  --output-format json \
  'Remember token TUNARA_SSH_CLAUDE_CONTEXT_9634 and reply exactly TUNARA_SSH_CLAUDE_FIRST_OK.' \
  < /dev/null > "$work/first.log" 2>&1
first_status=$?

CLAUDE_CONFIG_DIR="$work/config" timeout 120 claude -p \
  --resume "$session_id" \
  --permission-mode dontAsk \
  --output-format json \
  'If the remembered token is TUNARA_SSH_CLAUDE_CONTEXT_9634, reply exactly TUNARA_SSH_CLAUDE_RESUME_OK.' \
  < /dev/null > "$work/resume.log" 2>&1
resume_status=$?

python3 - "$work" "$first_status" "$resume_status" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
first = (root / "first.log").read_text(errors="replace")
resume = (root / "resume.log").read_text(errors="replace")
session_files = list((root / "config").rglob("*.jsonl"))
history = "\n".join(path.read_text(errors="replace") for path in session_files)
statuses = [int(sys.argv[2]), int(sys.argv[3])]

def events(raw: str) -> list[object]:
    result = []
    for line in raw.splitlines():
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return result

def classify(raw: str, status: int) -> str | None:
    text = raw.lower()
    if status in (124, 137) or "timed out" in text or "timeout" in text:
        return "timeout"
    if "402" in text or "credit balance" in text:
        return "provider_402"
    if "401" in text or "authentication" in text or "api key" in text:
        return "missing_or_invalid_api_key"
    if "rate limit" in text:
        return "rate_limit"
    if status != 0 or '"is_error":true' in text or '"is_error": true' in text:
        return "provider_or_cli_error"
    return None

first_marker = "TUNARA_SSH_CLAUDE_FIRST_OK" in first
resume_marker = "TUNARA_SSH_CLAUDE_RESUME_OK" in resume
identity = "TUNARA_SSH_CLAUDE_CONTEXT_9634" in history
strong_success = identity and first_marker and resume_marker and statuses == [0, 0]
error_class = None if strong_success else classify(first, statuses[0]) or classify(resume, statuses[1])

print(json.dumps({
    "firstExit": statuses[0],
    "resumeExit": statuses[1],
    "sessionIdentityObserved": identity,
    "firstMarkerObserved": first_marker,
    "resumeMarkerObserved": resume_marker,
    "jsonEvents": len(events(first)) + len(events(resume)),
    "errorClass": error_class,
    "passed": strong_success and error_class is None,
}, ensure_ascii=False))
PY
