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

# Agent wrapper: intercept hookable agents and compose native lifecycle hooks.
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

  # Writes one private runtime containing both a Droid settings file and a
  # Claude plugin. Plugin hooks compose with Claude's user --settings instead
  # of competing for the CLI's single effective settings argument.
  # host-provided agent-hook.sh helper. That helper reads the hook's stdin JSON,
  # extracts the agent's real session_id, and relays it as agent_session_id — so
  # resume uses the agent's own id instead of scraping the typed command line.
  # The hook command resolves the helper through the inherited config-dir env,
  # keeping filesystem-path quoting valid inside settings JSON. Echoes the
  # runtime path, or nothing if the helper/config directory is unavailable.
  _tunara_agent_write_hooks() {
    local sid="$1" agent="$2" config_dir="$3"
    [ -n "$config_dir" ] && [ -d "$config_dir" ] || return 1
    local helper="$config_dir/agent-hook.sh"
    [ -f "$helper" ] || return 1
    local runtime sf
    runtime="$(mktemp -d "$config_dir/tunara-agent-${sid}.XXXXXX" 2>/dev/null)" || return 1
    chmod 700 "$runtime" 2>/dev/null || { rm -rf "$runtime"; return 1; }
    mkdir -p "$runtime/.claude-plugin" "$runtime/hooks" || { rm -rf "$runtime"; return 1; }
    sf="$runtime/settings.json"
    # Keep the actual path out of JSON so home/config directories containing
    # spaces or quotes remain valid hook commands.
    local helper_command='sh \"$TUNARA_AGENT_CONFIG_DIR/agent-hook.sh\"'
    local idle="${helper_command} idle ${agent} ${sid}"
    local busy="${helper_command} busy ${agent} ${sid}"
    local wait="${helper_command} wait ${agent} ${sid}"
    local stop="${helper_command} stop ${agent} ${sid}"
    cat > "$sf" <<TUNARA_EOF
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_EOF
    cat > "$runtime/hooks/hooks.json" <<TUNARA_EOF
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"${wait}"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PostToolUseFailure":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_EOF
    printf '%s\n' '{"name":"tunara-lifecycle","description":"Tunara session lifecycle bridge","version":"1.0.0"}' > "$runtime/.claude-plugin/plugin.json"
    chmod 600 "$sf" "$runtime/hooks/hooks.json" "$runtime/.claude-plugin/plugin.json" 2>/dev/null || true
    printf '%s' "$runtime"
    return 0
  }

  _tunara_agent_run() {
    local real_bin="$1"; shift
    local agent="$1"; shift
    local sid="$TUNARA_SESSION_ID"
    local config_dir="${TUNARA_AGENT_CONFIG_DIR:-}"
    local runtime=""
    _tunara_agent_emit start "$agent"
    # Native hooks primarily return over OSC 777 through /dev/tty; the Unix
    # socket is an optional duplicate transport, not a prerequisite.
    runtime="$(_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")" || runtime=""
    if [ -n "$runtime" ] && [ "$real_bin" = "claude" ]; then
      command "$real_bin" --plugin-dir "$runtime" "$@"
    elif [ -n "$runtime" ]; then
      local user_settings="" has_user_settings=0 settings="$runtime/settings.json"
      local -a forwarded=()
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --settings)
            if [ "$#" -ge 2 ]; then
              user_settings="$2"
              has_user_settings=1
              shift 2
              continue
            fi
            forwarded+=("$1")
            ;;
          --settings=*)
            user_settings="${1#--settings=}"
            has_user_settings=1
            ;;
          *) forwarded+=("$1") ;;
        esac
        shift
      done
      if [ "$has_user_settings" = 1 ]; then
        local merged="$runtime/merged-settings.json"
        if sh "$config_dir/agent-hook.sh" merge-settings "$user_settings" "$settings" "$merged" 2>/dev/null; then
          settings="$merged"
        else
          settings="$user_settings"
        fi
      fi
      command "$real_bin" --settings "$settings" "${forwarded[@]}"
    else
      command "$real_bin" "$@"
    fi
    local ret=$?
    _tunara_agent_emit exit "$agent" "$ret"
    [ -n "$runtime" ] && rm -rf "$runtime"
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

  _tunara_agent_alias_tail() {
    local bin="$1" line value
    line="$(alias "$bin" 2>/dev/null)" || return 0
    value="${line#*=}"
    eval "value=$value" 2>/dev/null || return 0
    case "$value" in
      "$bin ") ;;
      "$bin "*) printf '%s' "${value#"$bin"}" ;;
    esac
  }
  __tunara_claude_alias_tail="$(_tunara_agent_alias_tail claude)"
  __tunara_droid_alias_tail="$(_tunara_agent_alias_tail droid)"
  __tunara_codex_alias_tail="$(_tunara_agent_alias_tail codex)"
  # A pre-existing alias takes precedence over a function during command
  # lookup. Rebuild ordinary `agent <flags>` aliases so they enter Tunara's
  # wrapper without losing the user's default model/profile/permission flags.
  unalias claude droid codex 2>/dev/null
  function claude { _tunara_agent_run claude CC "$@"; }
  function droid { _tunara_agent_run droid DR "$@"; }
  function codex { _tunara_agent_plain_run codex CX "$@"; }
  [ -n "$__tunara_claude_alias_tail" ] && alias claude="_tunara_agent_run claude CC$__tunara_claude_alias_tail"
  [ -n "$__tunara_droid_alias_tail" ] && alias droid="_tunara_agent_run droid DR$__tunara_droid_alias_tail"
  [ -n "$__tunara_codex_alias_tail" ] && alias codex="_tunara_agent_plain_run codex CX$__tunara_codex_alias_tail"
  unset __tunara_claude_alias_tail __tunara_droid_alias_tail __tunara_codex_alias_tail
fi
:
