#!/bin/sh
# Tunara agent lifecycle hook helper (written by the host at startup).
#
# Invoked by an agent's own hook system (e.g. Claude Code SessionStart/Stop/
# Notification) as: sh agent-hook.sh <event> <agent> <logical_session>
# The agent passes its hook payload JSON on stdin, which carries the agent's
# real session_id. We extract it and relay it to the host over the hooks socket
# as agent_session_id, so resume can use the agent's own id instead of scraping
# the command the user typed.
#
# No jq dependency: extract "session_id" with tr/grep/cut. Field-name is quoted
# in the match so look-alike keys (e.g. *_session_id) don't get picked up.
[ -n "$TUNARA_HOOKS_SOCK" ] || exit 0
asid="$(tr ',' '\n' | grep '"session_id"' | head -1 | tr -d ' ' | cut -d'"' -f4)"
printf '{"event":"%s","session":"%s","agent":"%s","agent_session_id":"%s"}' \
  "$1" "$3" "$2" "$asid" | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1 || true
