#!/usr/bin/env bash
set -u

work="$(mktemp -d /tmp/tunara-pi-resume.XXXXXXXX)"
session_id="55555555-5555-4555-8555-555555555555"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [[ "${TUNARA_PI_USE_NPX:-0}" == "1" ]]; then
  pi_command=(npx -y @earendil-works/pi-coding-agent@0.79.4)
else
  pi_command=(pi)
fi

common=(
  --no-extensions
  --no-skills
  --no-context-files
  --no-tools
  --session-dir "$work/sessions"
  --mode json
  --print
)

PI_OFFLINE=1 timeout 120 "${pi_command[@]}" "${common[@]}" --session-id "$session_id" \
  'Remember token TUNARA_PI_CONTEXT_7412 and reply exactly TUNARA_PI_FIRST_OK.' \
  < /dev/null > "$work/first.log" 2>&1
first_status=$?

PI_OFFLINE=1 timeout 120 "${pi_command[@]}" "${common[@]}" --session "$session_id" \
  'If the remembered token is TUNARA_PI_CONTEXT_7412, reply exactly TUNARA_PI_RESUME_OK.' \
  < /dev/null > "$work/resume.log" 2>&1
resume_status=$?

python3 - "$work" "$first_status" "$resume_status" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
first = (root / "first.log").read_text(errors="replace")
resume = (root / "resume.log").read_text(errors="replace")
session_files = list((root / "sessions").rglob("*.jsonl")) if (root / "sessions").exists() else []
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
    if "no api key" in text or "api key not found" in text or "authentication" in text:
        return "missing_or_invalid_api_key"
    if "rate limit" in text:
        return "rate_limit"
    if status != 0 or '"type":"error"' in text or '"type": "error"' in text:
        return "provider_or_cli_error"
    return None

first_marker = "TUNARA_PI_FIRST_OK" in first
resume_marker = "TUNARA_PI_RESUME_OK" in resume
identity = len(session_files) == 1 and "TUNARA_PI_CONTEXT_7412" in history
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
