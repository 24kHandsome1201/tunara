#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: opencode-loopback-probe.sh OPENCODE_BINARY" >&2
  exit 2
fi

opencode_binary="$1"
runtime="/tmp/tunara-opencode-probe-$$"
port=$((40000 + $$ % 20000))
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT

mkdir -p "$runtime"
python3 -c 'from http.server import BaseHTTPRequestHandler,HTTPServer; import sys; H=type("H",(BaseHTTPRequestHandler,),{"do_POST":lambda s:(s.send_response(401),s.end_headers()),"log_message":lambda *a:None}); HTTPServer(("127.0.0.1",int(sys.argv[1])),H).serve_forever()' "$port" >/dev/null 2>&1 &
server_pid=$!

config=$(printf '{"model":"tunara-probe/probe","tools":{"write":false,"bash":false},"provider":{"tunara-probe":{"npm":"@ai-sdk/openai-compatible","name":"Tunara Probe","options":{"baseURL":"http://127.0.0.1:%s/v1","apiKey":"probe"},"models":{"probe":{"name":"Probe"}}}}}' "$port")

cd /tmp
env \
  HOME="$runtime/home" \
  XDG_CONFIG_HOME="$runtime/config" \
  XDG_DATA_HOME="$runtime/data" \
  OPENCODE_CONFIG_CONTENT="$config" \
  "$opencode_binary" --pure
