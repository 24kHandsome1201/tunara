#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TUNARA_M1_SSH_TARGET:-de-netcup}"
OUTPUT="${TUNARA_SSH_PI_LOOPBACK_RESULT:-/tmp/ssh-pi-loopback-resume-summary.json}"
archive="$(mktemp /tmp/tunara-ssh-pi-loopback.XXXXXXXX.tar)"
remote_result="$(mktemp /tmp/tunara-ssh-pi-loopback-result.XXXXXXXX.json)"
cleanup() { rm -f "$archive" "$remote_result"; }
trap cleanup EXIT

COPYFILE_DISABLE=1 tar -cf "$archive" -C "$ROOT" \
  scripts/pi-resume-probe.sh \
  scripts/fixtures/pi-loopback-provider.py

ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" '
  runtime=$(mktemp -d /tmp/tunara-ssh-pi-loopback.XXXXXXXX)
  trap '\''rm -rf "$runtime"'\'' EXIT
  mkdir -p "$runtime/home" "$runtime/npm-cache"
  : > "$runtime/npmrc"
  tar -xf - -C "$runtime"
  env \
    -u OPENAI_API_KEY \
    -u ANTHROPIC_API_KEY \
    -u GOOGLE_API_KEY \
    -u GEMINI_API_KEY \
    -u MISTRAL_API_KEY \
    -u GROQ_API_KEY \
    HOME="$runtime/home" \
    NPM_CONFIG_USERCONFIG="$runtime/npmrc" \
    npm_config_cache="$runtime/npm-cache" \
    TUNARA_PI_USE_NPX=1 \
    TUNARA_PI_PROVIDER_MODE=loopback \
    "$runtime/scripts/pi-resume-probe.sh"
' < "$archive" > "$remote_result"

python3 - "$remote_result" "$OUTPUT" "$TARGET" "$(git -C "$ROOT" rev-parse HEAD)" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

source, output, target, commit = sys.argv[1:5]
payload = json.loads(pathlib.Path(source).read_text())
result = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "commit": commit,
    "target": target,
    "agent": "pi",
    "probe": "ssh-loopback-context-resume",
    "result": payload,
}
path = pathlib.Path(output)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
if payload.get("passed") is not True:
    raise SystemExit(1)
PY

echo "SSH Pi loopback resume complete: $OUTPUT"
python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["result"], indent=2))' "$OUTPUT"
