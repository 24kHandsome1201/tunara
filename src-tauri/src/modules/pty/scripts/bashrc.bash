# tunara-shell-integration (bashrc)
#
# Differences vs zsh integration:
# - We emulate login-shell init manually (/etc/profile, profile files) because
#   bash ignores --rcfile when started with -l.
# - Pre-exec marker uses PS0 (bash 4.4+). On older bash (macOS default 3.2) we
#   skip it — a fragile DEBUG-trap alternative would clobber the user's own
#   traps and interact badly with debuggers.

if [ -z "$__TUNARA_HOOKS_LOADED" ]; then
  __TUNARA_HOOKS_LOADED=1

  [ -f /etc/profile ] && source /etc/profile
  [ -f /etc/bashrc ] && source /etc/bashrc
  if [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
  elif [ -f "$HOME/.bash_login" ]; then
    source "$HOME/.bash_login"
  elif [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile"
  fi
  # .bashrc may have been sourced already by .bash_profile; sourcing again is
  # safe for idempotent rc files (the common case). If yours has side effects
  # on reload, guard with a flag.
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

  _tunara_urlencode() {
    local LC_ALL=C s="$1" i c
    for (( i=0; i<${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9/._~-]) printf '%s' "$c" ;;
        *) printf '%%%02X' "'$c" ;;
      esac
    done
  }

  _tunara_precmd() {
    local _tunara_ret=$?
    printf '\e]133;D;%s\e\\' "$_tunara_ret"
    printf '\e]7;file://localhost%s\e\\' "$(_tunara_urlencode "$PWD")"
    if [ -z "$__TUNARA_PS1_INJECTED" ]; then
      PS1='\[\e]133;B\e\\\]'"$PS1"
      __TUNARA_PS1_INJECTED=1
    fi
    printf '\e]133;A\e\\'
  }

  case ":${PROMPT_COMMAND:-}:" in
    *":_tunara_precmd:"*) ;;
    *) PROMPT_COMMAND="_tunara_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac

  # Pre-exec marker via PS0 (bash 4.4+). PS0 is expanded just before a command
  # runs — cleaner than a DEBUG trap, which would clobber user traps and fire
  # on every command including inside PROMPT_COMMAND.
  if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] \
     || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
    PS0='\[\e]133;C\e\\\]'"${PS0:-}"
  fi

  _tunara_precmd
fi

# Agent wrapper: intercept hookable agents, inject --settings for lifecycle hooks
# OSC 777 keeps the UI lifecycle reliable even when nc is missing or the hook socket is unavailable.
if [ -n "$TUNARA_SESSION_ID" ]; then
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
    if [ -z "$TUNARA_HOOKS_SOCK" ]; then
      return 0
    fi
    if [ -n "$code" ]; then
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
    [ -n "$config_dir" ] && [ -d "$config_dir" ] || return 1
    local helper="$config_dir/agent-hook.sh"
    [ -f "$helper" ] || return 1
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
    if [ -n "$sock" ]; then
      sf="$(_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")" || sf=""
    fi
    if [ -n "$sf" ]; then
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
