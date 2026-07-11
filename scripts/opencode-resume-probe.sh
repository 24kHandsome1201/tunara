#!/usr/bin/env bash
set -u

work="$(mktemp -d /tmp/tunara-opencode-resume.XXXXXXXX)"
title="Tunara-resume-probe-$$"
session_id=""

cleanup() {
  if [[ -n "$session_id" ]]; then
    opencode session delete "$session_id" > /dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

list_sessions() {
  opencode session list 2>/dev/null || true
}

# A short interrupted provider call is enough for OpenCode to allocate the
# uniquely titled session. The same id is then used for both context turns.
timeout 8 opencode run --pure --format json --title "$title" \
  'Initialize the isolated Tunara resume probe.' \
  < /dev/null > "$work/create.log" 2>&1
create_status=$?
session_id="$(list_sessions | awk -v title="$title" 'index($0, title) { print $1; exit }')"

if [[ -n "$session_id" ]]; then
  timeout 60 opencode run --pure --format json --session "$session_id" \
    'Remember token TUNARA_OPENCODE_CONTEXT_5284 and reply exactly TUNARA_OPENCODE_FIRST_OK.' \
    < /dev/null > "$work/first.log" 2>&1
  first_status=$?
  timeout 60 opencode run --pure --format json --session "$session_id" \
    'If the remembered token is TUNARA_OPENCODE_CONTEXT_5284, reply exactly TUNARA_OPENCODE_RESUME_OK.' \
    < /dev/null > "$work/resume.log" 2>&1
  resume_status=$?
  if list_sessions | awk -v id="$session_id" '$1 == id { found = 1 } END { exit !found }'; then
    session_identity=1
  else
    session_identity=0
  fi
else
  first_status=125
  resume_status=125
  session_identity=0
  : > "$work/first.log"
  : > "$work/resume.log"
fi

python3 - "$work" "$create_status" "$first_status" "$resume_status" "$session_identity" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
create = (root / "create.log").read_text(errors="replace")
first = (root / "first.log").read_text(errors="replace")
resume = (root / "resume.log").read_text(errors="replace")
statuses = [int(value) for value in sys.argv[2:5]]

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
    if "401" in text or "authentication" in text or "api key" in text:
        return "missing_or_invalid_api_key"
    if "rate limit" in text:
        return "rate_limit"
    if status == 125:
        return "session_not_created"
    if status != 0 or "error" in text:
        return "provider_or_cli_error"
    return None

first_marker = "TUNARA_OPENCODE_FIRST_OK" in first
resume_marker = "TUNARA_OPENCODE_RESUME_OK" in resume
identity = sys.argv[5] == "1"
error_class = None
for raw, status in zip((create, first, resume), statuses):
    error_class = error_class or classify(raw, status)

print(json.dumps({
    "createExit": statuses[0],
    "firstExit": statuses[1],
    "resumeExit": statuses[2],
    "sessionIdentityObserved": identity,
    "firstMarkerObserved": first_marker,
    "resumeMarkerObserved": resume_marker,
    "jsonEvents": len(events(first)) + len(events(resume)),
    "errorClass": error_class,
    "passed": identity and first_marker and resume_marker and error_class is None,
}, ensure_ascii=False))
PY
