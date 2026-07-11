#!/usr/bin/env bash
set -u

work="$(mktemp -d /tmp/tunara-pi-resume.XXXXXXXX)"
session_id="55555555-5555-4555-8555-555555555555"
provider_mode="${TUNARA_PI_PROVIDER_MODE:-external}"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
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

probe_env=(PI_OFFLINE=1)
if [[ "$provider_mode" == "loopback" ]]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  provider="$script_dir/fixtures/pi-loopback-provider.py"
  if [[ ! -f "$provider" ]]; then
    echo '{"passed":false,"errorClass":"loopback_fixture_missing"}'
    exit 2
  fi
  mkdir -p "$work/agent" "$work/sessions"
  provider_token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  python3 "$provider" "$work/provider-state.json" "$work/provider-port" "$provider_token" > /dev/null 2>&1 &
  server_pid=$!
  for _ in {1..100}; do
    [[ -s "$work/provider-port" ]] && break
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.05
  done
  if [[ ! -s "$work/provider-port" ]]; then
    echo '{"passed":false,"errorClass":"loopback_provider_start_failed"}'
    exit 2
  fi
  provider_port="$(tr -d '[:space:]' < "$work/provider-port")"
  cat > "$work/agent/models.json" <<JSON
{
  "providers": {
    "tunara-loopback": {
      "baseUrl": "http://127.0.0.1:${provider_port}/v1",
      "api": "openai-completions",
      "apiKey": "${provider_token}",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsStore": false
      },
      "models": [{
        "id": "probe",
        "name": "Tunara deterministic resume probe",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 8192,
        "maxTokens": 64,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
      }]
    }
  }
}
JSON
  probe_env=(PI_CODING_AGENT_DIR="$work/agent")
  common+=(--provider tunara-loopback --model probe)
fi

pi_version="$(env "${probe_env[@]}" "${pi_command[@]}" --version 2>/dev/null | head -1 | tr -d '\r')"

env "${probe_env[@]}" timeout 120 "${pi_command[@]}" "${common[@]}" --session-id "$session_id" \
  'Remember token TUNARA_PI_CONTEXT_7412 and reply exactly TUNARA_PI_FIRST_OK.' \
  < /dev/null > "$work/first.log" 2>&1
first_status=$?

env "${probe_env[@]}" timeout 120 "${pi_command[@]}" "${common[@]}" --session "$session_id" \
  'TUNARA_PI_RESUME_REQUEST_8524: If the remembered token is TUNARA_PI_CONTEXT_7412, reply exactly TUNARA_PI_RESUME_OK.' \
  < /dev/null > "$work/resume.log" 2>&1
resume_status=$?

python3 - "$work" "$first_status" "$resume_status" "$provider_mode" "$pi_version" "$session_id" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
first = (root / "first.log").read_text(errors="replace")
resume = (root / "resume.log").read_text(errors="replace")
session_files = list((root / "sessions").rglob("*.jsonl")) if (root / "sessions").exists() else []
history = "\n".join(path.read_text(errors="replace") for path in session_files)
statuses = [int(sys.argv[2]), int(sys.argv[3])]
provider_mode = sys.argv[4]
pi_version = sys.argv[5]
session_id = sys.argv[6]

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
identity = len(session_files) == 1 and session_id in history and "TUNARA_PI_CONTEXT_7412" in history
provider_state = {}
state_path = root / "provider-state.json"
if state_path.exists():
    try:
        provider_state = json.loads(state_path.read_text())
    except json.JSONDecodeError:
        provider_state = {}
loopback_ok = provider_mode != "loopback" or (
    provider_state.get("mainRequestCount") == 2
    and provider_state.get("allClientsLoopback") is True
    and provider_state.get("allRequestsAuthenticated") is True
    and provider_state.get("authorizationFailures") == 0
    and provider_state.get("firstContextSeen") is True
    and provider_state.get("resumeContextSeen") is True
    and provider_state.get("firstAssistantMarkerReplayed") is True
)
strong_success = identity and first_marker and resume_marker and statuses == [0, 0] and loopback_ok
if strong_success:
    error_class = None
elif provider_mode == "loopback" and not loopback_ok:
    error_class = "loopback_contract_failed"
elif not identity:
    error_class = "session_identity_failed"
elif not first_marker or not resume_marker:
    error_class = "marker_missing"
else:
    error_class = classify(first, statuses[0]) or classify(resume, statuses[1]) or "unknown_failure"

print(json.dumps({
    "firstExit": statuses[0],
    "resumeExit": statuses[1],
    "piVersion": pi_version,
    "sessionId": session_id,
    "providerMode": provider_mode,
    "providerEndpoint": "loopback-only" if provider_mode == "loopback" else "configured-external",
    "externalModelReached": False if provider_mode == "loopback" else None,
    "toolsEnabled": False,
    "sessionFileCount": len(session_files),
    "sessionIdentityObserved": identity,
    "firstMarkerObserved": first_marker,
    "resumeMarkerObserved": resume_marker,
    "jsonEvents": len(events(first)) + len(events(resume)),
    "requestCount": provider_state.get("requestCount", 0),
    "mainRequestCount": provider_state.get("mainRequestCount", 0),
    "auxiliaryRequestCount": provider_state.get("auxiliaryRequestCount", 0),
    "allClientsLoopback": provider_state.get("allClientsLoopback") is True,
    "allRequestsAuthenticated": provider_state.get("allRequestsAuthenticated") is True,
    "authorizationFailures": provider_state.get("authorizationFailures", 0),
    "firstContextSeen": provider_state.get("firstContextSeen") is True,
    "resumeContextSeen": provider_state.get("resumeContextSeen") is True,
    "firstAssistantMarkerReplayed": provider_state.get("firstAssistantMarkerReplayed") is True,
    "requestObservations": provider_state.get("observations", []) if not strong_success else [],
    "rawLogsRetained": False,
    "errorClass": error_class,
    "passed": strong_success and error_class is None,
}, ensure_ascii=False))
PY
