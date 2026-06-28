# tunara-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_tunara_ret`.

{
  _tunara_user_zdotdir="${TUNARA_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tunara_user_zdotdir/.zshrc" ] && source "$_tunara_user_zdotdir/.zshrc"
  unset _tunara_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__TUNARA_HOOKS_LOADED" ]]; then
  __TUNARA_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _tunara_urlencode() {
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

  _tunara_precmd() {
    local _tunara_ret=$?
    printf '\e]133;D;%s\e\\' "$_tunara_ret"
    printf '\e]7;file://localhost%s\e\\' "$(_tunara_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _tunara_preexec() {
    printf '\e]133;C;%s\e\\' "$(_tunara_urlencode "$1")"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _tunara_precmd
    add-zsh-hook preexec _tunara_preexec
  fi

  _tunara_precmd
fi

# Agent wrapper: intercept hookable agents, inject --settings for lifecycle hooks
# OSC 777 keeps the UI lifecycle reliable even when nc is missing or the hook socket is unavailable.
if [[ -n "$TUNARA_SESSION_ID" ]]; then
  _tunara_agent_osc() {
    local event="$1"
    local agent="$2"
    local code="${3:-}"
    printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' "$event" "$TUNARA_SESSION_ID" "$agent" "$code"
  }

  _tunara_agent_emit() {
    local event="$1"
    local agent="$2"
    local code="${3:-}"
    _tunara_agent_osc "$event" "$agent" "$code"
    if [[ -z "$TUNARA_HOOKS_SOCK" ]]; then
      return 0
    fi
    if [[ -n "$code" ]]; then
      printf '{"event":"%s","session":"%s","agent":"%s","code":%s}' "$event" "$TUNARA_SESSION_ID" "$agent" "$code" | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1 || true
    else
      printf '{"event":"%s","session":"%s","agent":"%s"}' "$event" "$TUNARA_SESSION_ID" "$agent" | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1 || true
    fi
  }

  # Writes a Claude-Code --settings file pointing each lifecycle hook at the
  # host-provided agent-hook.sh helper. That helper reads the hook's stdin JSON,
  # extracts the agent's real session_id, and relays it as agent_session_id — so
  # resume uses the agent's own id instead of scraping the typed command line.
  # The hook command is just `sh <helper> <event> <agent> <sid>`, so no quoting
  # has to survive the nested settings JSON. Echoes the settings path, or
  # nothing if the helper or config dir is unavailable.
  _tunara_agent_write_hooks() {
    local sid="$1" agent="$2" config_dir="$3"
    [[ -n "$config_dir" && -d "$config_dir" ]] || return 1
    local helper="$config_dir/agent-hook.sh"
    [[ -f "$helper" ]] || return 1
    local sf
    sf="$(mktemp "$config_dir/tunara-agent-${sid}.XXXXXX.json" 2>/dev/null)" || return 1
    chmod 600 "$sf" 2>/dev/null || true
    local idle="sh ${helper} idle ${agent} ${sid}"
    local stop="sh ${helper} stop ${agent} ${sid}"
    cat > "$sf" <<TUNARA_EOF
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_EOF
    printf '%s' "$sf"
    return 0
  }

  _tunara_agent_run() {
    local real_bin="$1"; shift
    local agent="$1"; shift
    local sid="$TUNARA_SESSION_ID"
    local sock="$TUNARA_HOOKS_SOCK"
    local config_dir="${TUNARA_AGENT_CONFIG_DIR:-}"
    local sf=""
    _tunara_agent_emit start "$agent"
    if [[ -n "$sock" ]]; then
      sf="$(_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")" || sf=""
    fi
    if [[ -n "$sf" ]]; then
      command "$real_bin" --settings "$sf" "$@"
    else
      command "$real_bin" "$@"
    fi
    local ret=$?
    _tunara_agent_emit exit "$agent" "$ret"
    rm -f "$sf" 2>/dev/null
    return $ret
  }

  _tunara_agent_plain_run() {
    local real_bin="$1"; shift
    local agent="$1"; shift
    _tunara_agent_emit start "$agent"
    command "$real_bin" "$@"
    local ret=$?
    _tunara_agent_emit exit "$agent" "$ret"
    return $ret
  }

  claude() { _tunara_agent_run claude CC "$@"; }
  droid() { _tunara_agent_run droid DR "$@"; }
  codex() { _tunara_agent_plain_run codex CX "$@"; }
fi
:
