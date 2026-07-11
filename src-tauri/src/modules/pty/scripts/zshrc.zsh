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
    printf '\e]133;D;%s;tunara-shell\e\\' "$_tunara_ret"
    printf '\e]7;file://localhost%s\e\\' "$(_tunara_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A;tunara-shell\e\\'
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

# Agent wrapper: intercept hookable agents and compose native lifecycle hooks.
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

  # Writes one private runtime containing both a Droid settings file and a
  # Claude plugin. Plugin hooks compose with Claude's user --settings instead
  # of competing for the CLI's single effective settings argument.
  # host-provided agent-hook.sh helper. That helper reads the hook's stdin JSON,
  # extracts the agent's real session_id, and relays it as agent_session_id — so
  # resume uses the agent's own id instead of scraping the typed command line.
  # The helper path stays behind the inherited config-dir env so spaces and
  # quotes remain valid inside settings JSON. Echoes the runtime path, or
  # nothing if the helper/config directory is unavailable.
  _tunara_agent_write_hooks() {
    local sid="$1" agent="$2" config_dir="$3"
    [[ -n "$config_dir" && -d "$config_dir" ]] || return 1
    local helper="$config_dir/agent-hook.sh"
    [[ -f "$helper" ]] || return 1
    local runtime sf
    runtime="$(mktemp -d "$config_dir/tunara-agent-${sid}.XXXXXX" 2>/dev/null)" || return 1
    chmod 700 "$runtime" 2>/dev/null || { rm -rf "$runtime"; return 1; }
    mkdir -p "$runtime/.claude-plugin" "$runtime/hooks" || { rm -rf "$runtime"; return 1; }
    sf="$runtime/settings.json"
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
    runtime="$(_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")" || runtime=""
    if [[ -n "$runtime" && "$real_bin" == "claude" ]]; then
      command "$real_bin" --plugin-dir "$runtime" "$@"
    elif [[ -n "$runtime" ]]; then
      local user_settings="" has_user_settings=0 settings="$runtime/settings.json"
      local -a forwarded=()
      while [[ "$#" -gt 0 ]]; do
        case "$1" in
          --settings)
            if [[ "$#" -ge 2 ]]; then
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
      if [[ "$has_user_settings" == 1 ]]; then
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
    [[ -n "$runtime" ]] && rm -rf "$runtime"
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
  # Aliases win command lookup over functions in zsh too. Rebuild ordinary
  # aliases through the wrapper so their default flags remain intact.
  unalias claude droid codex 2>/dev/null
  function claude { _tunara_agent_run claude CC "$@"; }
  function droid { _tunara_agent_run droid DR "$@"; }
  function codex { _tunara_agent_plain_run codex CX "$@"; }
  [[ -n "$__tunara_claude_alias_tail" ]] && alias claude="_tunara_agent_run claude CC$__tunara_claude_alias_tail"
  [[ -n "$__tunara_droid_alias_tail" ]] && alias droid="_tunara_agent_run droid DR$__tunara_droid_alias_tail"
  [[ -n "$__tunara_codex_alias_tail" ]] && alias codex="_tunara_agent_plain_run codex CX$__tunara_codex_alias_tail"
  unset __tunara_claude_alias_tail __tunara_droid_alias_tail __tunara_codex_alias_tail
fi
:
