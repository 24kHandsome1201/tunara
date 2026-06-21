# conduit-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_conduit_ret`.

{
  _conduit_user_zdotdir="${CONDUIT_USER_ZDOTDIR:-$HOME}"
  [ -f "$_conduit_user_zdotdir/.zshrc" ] && source "$_conduit_user_zdotdir/.zshrc"
  unset _conduit_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__CONDUIT_HOOKS_LOADED" ]]; then
  __CONDUIT_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _conduit_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _conduit_precmd() {
    local _conduit_ret=$?
    printf '\e]133;D;%s\e\\' "$_conduit_ret"
    printf '\e]7;file://localhost%s\e\\' "$(_conduit_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _conduit_preexec() {
    printf '\e]133;C;%s\e\\' "$(_conduit_urlencode "$1")"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _conduit_precmd
    add-zsh-hook preexec _conduit_preexec
  fi

  _conduit_precmd
fi

# Agent wrapper: intercept hookable agents, inject --settings for lifecycle hooks
# OSC 777 keeps the UI lifecycle reliable even when nc is missing or the hook socket is unavailable.
if [[ -n "$CONDUIT_SESSION_ID" ]]; then
  _conduit_agent_osc() {
    local event="$1"
    local agent="$2"
    local code="${3:-}"
    printf '\e]777;conduit-agent;%s;%s;%s;%s\e\\' "$event" "$CONDUIT_SESSION_ID" "$agent" "$code"
  }

  _conduit_agent_emit() {
    local event="$1"
    local agent="$2"
    local code="${3:-}"
    _conduit_agent_osc "$event" "$agent" "$code"
    if [[ -z "$CONDUIT_HOOKS_SOCK" ]]; then
      return 0
    fi
    if [[ -n "$code" ]]; then
      printf '{"event":"%s","session":"%s","agent":"%s","code":%s}' "$event" "$CONDUIT_SESSION_ID" "$agent" "$code" | nc -U "$CONDUIT_HOOKS_SOCK" >/dev/null 2>&1 || true
    else
      printf '{"event":"%s","session":"%s","agent":"%s"}' "$event" "$CONDUIT_SESSION_ID" "$agent" | nc -U "$CONDUIT_HOOKS_SOCK" >/dev/null 2>&1 || true
    fi
  }

  _conduit_agent_run() {
    local real_bin="$1"; shift
    local agent="$1"; shift
    local sid="$CONDUIT_SESSION_ID"
    local sock="$CONDUIT_HOOKS_SOCK"
    local f="/tmp/conduit-agent-${sid}.json"
    _conduit_agent_emit start "$agent"
    if [[ -n "$sock" ]]; then
      cat > "$f" <<CONDUIT_EOF
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"printf '{\"event\":\"idle\",\"session\":\"${sid}\",\"agent\":\"${agent}\"}' | nc -U ${sock}"}]}],"Stop":[{"hooks":[{"type":"command","command":"printf '{\"event\":\"stop\",\"session\":\"${sid}\",\"agent\":\"${agent}\"}' | nc -U ${sock}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"printf '{\"event\":\"idle\",\"session\":\"${sid}\",\"agent\":\"${agent}\"}' | nc -U ${sock}"}]}]}}
CONDUIT_EOF
      command "$real_bin" --settings "$f" "$@"
    else
      command "$real_bin" "$@"
    fi
    local ret=$?
    _conduit_agent_emit exit "$agent" "$ret"
    rm -f "$f" 2>/dev/null
    return $ret
  }

  _conduit_agent_plain_run() {
    local real_bin="$1"; shift
    local agent="$1"; shift
    _conduit_agent_emit start "$agent"
    command "$real_bin" "$@"
    local ret=$?
    _conduit_agent_emit exit "$agent" "$ret"
    return $ret
  }

  claude() { _conduit_agent_run claude CC "$@"; }
  droid() { _conduit_agent_run droid DR "$@"; }
  codex() { _conduit_agent_plain_run codex CX "$@"; }
fi
:
