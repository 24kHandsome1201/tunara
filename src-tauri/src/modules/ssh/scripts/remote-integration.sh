# tunara remote shell integration (Phase 4, default-on).
#
# Injected as the first input to a remote interactive shell. Installs OSC 7
# (cwd) + OSC 133 A/B/C/D (prompt/command boundaries) hooks for bash or zsh so
# the host gets remote cwd + command detection. On top of that it WRAPS the
# agents so process start/exit emit OSC 777. Claude/Droid also receive native
# lifecycle hooks that emit explicit busy/idle/stop events around each turn.
# Those events are the reliable signal that survives the user's own
# prompt framework, since unlike the precmd hook it does not depend on the
# shell redrawing a prompt we control.
#
# `__TUNARA_SESSION_ID__` is substituted by the host (connection.rs) with the
# logical session id before injection, so the OSC 777 `session` field matches
# the frontend's sessionId (parseAgentLifecycleOsc drops events whose session
# doesn't match). Self-guards against double-install and degrades silently on
# unsupported shells.
#
# Transport: connection.rs stages this file into a private remote mktemp file
# over a NON-tty exec channel, and the interactive shell is sent only a short
# ` . file; rm -f file` line. Never send this script inline as shell input —
# a line longer than the pty's canonical buffer (4096 Linux / 1024 BSD) gets
# truncated by the line discipline when it lands before the shell enters raw
# mode: the eval never runs and the junk is echoed at the first prompt.
#
# This runs INSIDE the user's already-started remote shell, so it must not
# disturb their environment beyond adding precmd/preexec hooks and the agent
# function wrappers.
#
# Hardening vs. the original opt-in version: the precmd re-injects the OSC 133
# B marker into PS1 every prompt (so p10k/starship rebuilding PS1 can't drop
# command-boundary detection), and the agent wrappers give a prompt-framework-
# independent exit signal so the "running" badge always clears when an agent
# exits — the precmd's lone OSC 133 D is no longer the only path.

if [ -n "$ZSH_VERSION" ]; then
  if [ -z "$__TUNARA_REMOTE_LOADED" ]; then
    __TUNARA_REMOTE_LOADED=1
    autoload -Uz add-zsh-hook 2>/dev/null
    _tunara_r_enc() { local LC_ALL=C s="$1" i c; for ((i=1;i<=${#s};i++)); do c="${s[i]}"; case "$c" in [a-zA-Z0-9/._~-]) printf '%s' "$c";; *) printf '%%%02X' "'$c";; esac; done; }
    _tunara_r_precmd() { local r=$?; printf '\e]133;D;%s;tunara-shell\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then PS1=$'%{\e]133;B\e\\%}'"$PS1"; fi; printf '\e]133;A;tunara-shell\e\\'; }
    _tunara_r_preexec() { printf '\e]133;C;%s\e\\' "$(_tunara_r_enc "$1")"; }
    add-zsh-hook precmd _tunara_r_precmd 2>/dev/null
    add-zsh-hook preexec _tunara_r_preexec 2>/dev/null
    _tunara_r_precmd
    if [ -n "__TUNARA_SESSION_ID__" ]; then
      _tunara_r_agent_emit() { printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' "$1" "__TUNARA_SESSION_ID__" "$2" "${3:-}"; }
      _tunara_r_agent_hooks() {
        local sid="$1" agent="$2" runtime helper sf idle busy wait stop
        runtime="$(mktemp -d /tmp/.tunara-agent-XXXXXXXX 2>/dev/null)" || return 1
        chmod 700 "$runtime" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        helper="$runtime/hook.sh"
        sf="$runtime/settings.json"
        if printf '%s' '__TUNARA_AGENT_HOOK_B64__' | base64 --decode > "$helper" 2>/dev/null; then
          :
        elif printf '%s' '__TUNARA_AGENT_HOOK_B64__' | base64 -D > "$helper" 2>/dev/null; then
          :
        else
          rm -rf "$runtime"
          return 1
        fi
        chmod 700 "$helper" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        mkdir -p "$runtime/.claude-plugin" "$runtime/hooks" || { rm -rf "$runtime"; return 1; }
        idle="sh ${helper} idle ${agent} ${sid}"
        busy="sh ${helper} busy ${agent} ${sid}"
        wait="sh ${helper} wait ${agent} ${sid}"
        stop="sh ${helper} stop ${agent} ${sid}"
        cat > "$sf" <<TUNARA_REMOTE_SETTINGS
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_REMOTE_SETTINGS
        cat > "$runtime/hooks/hooks.json" <<TUNARA_REMOTE_SETTINGS
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"${wait}"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PostToolUseFailure":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_REMOTE_SETTINGS
        printf '%s\n' '{"name":"tunara-lifecycle","description":"Tunara session lifecycle bridge","version":"1.0.0"}' > "$runtime/.claude-plugin/plugin.json"
        chmod 600 "$sf" "$runtime/hooks/hooks.json" "$runtime/.claude-plugin/plugin.json" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        printf '%s' "$runtime"
      }
      _tunara_r_agent_run() {
        local bin="$1" agent="$2" runtime="" ret settings user_settings="" merged has_user_settings=0
        local -a forwarded=()
        shift 2
        _tunara_r_agent_emit start "$agent"
        runtime="$(_tunara_r_agent_hooks "__TUNARA_SESSION_ID__" "$agent")" || runtime=""
        if [ -n "$runtime" ] && [ "$bin" = claude ]; then
          command "$bin" --plugin-dir "$runtime" "$@"
        elif [ -n "$runtime" ]; then
          settings="$runtime/settings.json"
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --settings)
                if [ "$#" -ge 2 ]; then user_settings="$2"; has_user_settings=1; shift 2; continue; fi
                forwarded+=("$1")
                ;;
              --settings=*) user_settings="${1#--settings=}"; has_user_settings=1 ;;
              *) forwarded+=("$1") ;;
            esac
            shift
          done
          if [ "$has_user_settings" = 1 ]; then
            merged="$runtime/merged-settings.json"
            if sh "$runtime/hook.sh" merge-settings "$user_settings" "$settings" "$merged" 2>/dev/null; then settings="$merged"; else settings="$user_settings"; fi
          fi
          command "$bin" --settings "$settings" "${forwarded[@]}"
        else
          command "$bin" "$@"
        fi
        ret=$?
        _tunara_r_agent_emit exit "$agent" "$ret"
        [ -n "$runtime" ] && rm -rf "$runtime"
        return $ret
      }
      _tunara_r_agent_plain_run() { local bin="$1" agent="$2"; shift 2; _tunara_r_agent_emit start "$agent"; command "$bin" "$@"; local ret=$?; _tunara_r_agent_emit exit "$agent" "$ret"; return $ret; }
      _tunara_r_alias_tail() { local bin="$1" line value; line="$(alias "$bin" 2>/dev/null)" || return 0; value="${line#*=}"; eval "value=$value" 2>/dev/null || return 0; case "$value" in "$bin ") ;; "$bin "*) printf '%s' "${value#"$bin"}";; esac; }
      __tunara_claude_alias_tail="$(_tunara_r_alias_tail claude)"
      __tunara_droid_alias_tail="$(_tunara_r_alias_tail droid)"
      __tunara_codex_alias_tail="$(_tunara_r_alias_tail codex)"
      unalias claude droid codex 2>/dev/null
      function claude { _tunara_r_agent_run claude CC "$@"; }
      function droid { _tunara_r_agent_run droid DR "$@"; }
      function codex { _tunara_r_agent_plain_run codex CX "$@"; }
      [[ -n "$__tunara_claude_alias_tail" ]] && alias claude="_tunara_r_agent_run claude CC$__tunara_claude_alias_tail"
      [[ -n "$__tunara_droid_alias_tail" ]] && alias droid="_tunara_r_agent_run droid DR$__tunara_droid_alias_tail"
      [[ -n "$__tunara_codex_alias_tail" ]] && alias codex="_tunara_r_agent_plain_run codex CX$__tunara_codex_alias_tail"
      unset __tunara_claude_alias_tail __tunara_droid_alias_tail __tunara_codex_alias_tail
    fi
  fi
elif [ -n "$BASH_VERSION" ]; then
  if [ -z "$__TUNARA_REMOTE_LOADED" ]; then
    __TUNARA_REMOTE_LOADED=1
    _tunara_r_enc() { local LC_ALL=C s="$1" i c; for ((i=0;i<${#s};i++)); do c="${s:$i:1}"; case "$c" in [a-zA-Z0-9/._~-]) printf '%s' "$c";; *) printf '%%%02X' "'$c";; esac; done; }
    __TUNARA_REMOTE_INPUT_FALLBACK=0
    if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ] \
       || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -lt 4 ]; }; then
      __TUNARA_REMOTE_INPUT_FALLBACK=1
    fi
    _tunara_r_prompt() { local r=$?; printf '\e]133;D;%s;tunara-shell\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; case "$PS1" in *'\[\e]133;B\e\\\]'*) ;; *) PS1="${PS1}"'\[\e]133;B\e\\\]';; esac; if [ "$__TUNARA_REMOTE_INPUT_FALLBACK" = 1 ]; then printf '\e]133;A;tunara-shell;input-fallback\e\\'; else printf '\e]133;A;tunara-shell\e\\'; fi; }
    case "$PROMPT_COMMAND" in *_tunara_r_prompt*) ;; *) PROMPT_COMMAND="_tunara_r_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
    # Bash 4.4+ can emit a pre-exec marker through PS0 without taking over the
    # user's DEBUG trap. Older Bash keeps cwd/prompt integration and relies on
    # the frontend input scanner for command text.
    if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] \
       || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
      PS0='\[\e]133;C\e\\\]'"${PS0:-}"
    fi
    if [ -n "__TUNARA_SESSION_ID__" ]; then
      _tunara_r_agent_emit() { printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' "$1" "__TUNARA_SESSION_ID__" "$2" "${3:-}"; }
      _tunara_r_agent_hooks() {
        local sid="$1" agent="$2" runtime helper sf idle busy wait stop
        runtime="$(mktemp -d /tmp/.tunara-agent-XXXXXXXX 2>/dev/null)" || return 1
        chmod 700 "$runtime" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        helper="$runtime/hook.sh"
        sf="$runtime/settings.json"
        if printf '%s' '__TUNARA_AGENT_HOOK_B64__' | base64 --decode > "$helper" 2>/dev/null; then
          :
        elif printf '%s' '__TUNARA_AGENT_HOOK_B64__' | base64 -D > "$helper" 2>/dev/null; then
          :
        else
          rm -rf "$runtime"
          return 1
        fi
        chmod 700 "$helper" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        mkdir -p "$runtime/.claude-plugin" "$runtime/hooks" || { rm -rf "$runtime"; return 1; }
        idle="sh ${helper} idle ${agent} ${sid}"
        busy="sh ${helper} busy ${agent} ${sid}"
        wait="sh ${helper} wait ${agent} ${sid}"
        stop="sh ${helper} stop ${agent} ${sid}"
        cat > "$sf" <<TUNARA_REMOTE_SETTINGS
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_REMOTE_SETTINGS
        cat > "$runtime/hooks/hooks.json" <<TUNARA_REMOTE_SETTINGS
{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"${idle}"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"${wait}"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"${busy}"}]}],"PostToolUseFailure":[{"hooks":[{"type":"command","command":"${busy}"}]}],"Stop":[{"hooks":[{"type":"command","command":"${stop}"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"${stop}"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"${idle}"}]}]}}
TUNARA_REMOTE_SETTINGS
        printf '%s\n' '{"name":"tunara-lifecycle","description":"Tunara session lifecycle bridge","version":"1.0.0"}' > "$runtime/.claude-plugin/plugin.json"
        chmod 600 "$sf" "$runtime/hooks/hooks.json" "$runtime/.claude-plugin/plugin.json" 2>/dev/null || { rm -rf "$runtime"; return 1; }
        printf '%s' "$runtime"
      }
      _tunara_r_agent_run() {
        local bin="$1" agent="$2" runtime="" ret settings user_settings="" merged has_user_settings=0
        local -a forwarded=()
        shift 2
        _tunara_r_agent_emit start "$agent"
        runtime="$(_tunara_r_agent_hooks "__TUNARA_SESSION_ID__" "$agent")" || runtime=""
        if [ -n "$runtime" ] && [ "$bin" = claude ]; then
          command "$bin" --plugin-dir "$runtime" "$@"
        elif [ -n "$runtime" ]; then
          settings="$runtime/settings.json"
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --settings)
                if [ "$#" -ge 2 ]; then user_settings="$2"; has_user_settings=1; shift 2; continue; fi
                forwarded+=("$1")
                ;;
              --settings=*) user_settings="${1#--settings=}"; has_user_settings=1 ;;
              *) forwarded+=("$1") ;;
            esac
            shift
          done
          if [ "$has_user_settings" = 1 ]; then
            merged="$runtime/merged-settings.json"
            if sh "$runtime/hook.sh" merge-settings "$user_settings" "$settings" "$merged" 2>/dev/null; then settings="$merged"; else settings="$user_settings"; fi
          fi
          command "$bin" --settings "$settings" "${forwarded[@]}"
        else
          command "$bin" "$@"
        fi
        ret=$?
        _tunara_r_agent_emit exit "$agent" "$ret"
        [ -n "$runtime" ] && rm -rf "$runtime"
        return $ret
      }
      _tunara_r_agent_plain_run() { local bin="$1" agent="$2"; shift 2; _tunara_r_agent_emit start "$agent"; command "$bin" "$@"; local ret=$?; _tunara_r_agent_emit exit "$agent" "$ret"; return $ret; }
      _tunara_r_alias_tail() { local bin="$1" line value; line="$(alias "$bin" 2>/dev/null)" || return 0; value="${line#*=}"; eval "value=$value" 2>/dev/null || return 0; case "$value" in "$bin ") ;; "$bin "*) printf '%s' "${value#"$bin"}";; esac; }
      __tunara_claude_alias_tail="$(_tunara_r_alias_tail claude)"
      __tunara_droid_alias_tail="$(_tunara_r_alias_tail droid)"
      __tunara_codex_alias_tail="$(_tunara_r_alias_tail codex)"
      unalias claude droid codex 2>/dev/null
      function claude { _tunara_r_agent_run claude CC "$@"; }
      function droid { _tunara_r_agent_run droid DR "$@"; }
      function codex { _tunara_r_agent_plain_run codex CX "$@"; }
      [ -n "$__tunara_claude_alias_tail" ] && alias claude="_tunara_r_agent_run claude CC$__tunara_claude_alias_tail"
      [ -n "$__tunara_droid_alias_tail" ] && alias droid="_tunara_r_agent_run droid DR$__tunara_droid_alias_tail"
      [ -n "$__tunara_codex_alias_tail" ] && alias codex="_tunara_r_agent_plain_run codex CX$__tunara_codex_alias_tail"
      unset __tunara_claude_alias_tail __tunara_droid_alias_tail __tunara_codex_alias_tail
    fi
  fi
fi
