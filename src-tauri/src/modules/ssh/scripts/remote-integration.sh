# tunara remote shell integration (Phase 4, default-on).
#
# Injected as the first input to a remote interactive shell. Installs OSC 7
# (cwd) + OSC 133 A/B/C/D (prompt/command boundaries) hooks for bash or zsh so
# the host gets remote cwd + command detection. On top of that it WRAPS the
# hookable agents (claude/droid/codex) so their start/exit emit OSC 777
# lifecycle events — that is the reliable signal that survives the user's own
# prompt framework, since unlike the precmd hook it does not depend on the
# shell redrawing a prompt we control.
#
# `__TUNARA_SESSION_ID__` is substituted by the host (connection.rs) with the
# logical session id before injection, so the OSC 777 `session` field matches
# the frontend's sessionId (parseAgentLifecycleOsc drops events whose session
# doesn't match). Self-guards against double-install and degrades silently on
# unsupported shells. Kept on ONE logical line per shell so it can be sent as a
# single command without a heredoc.
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
    _tunara_r_precmd() { local r=$?; printf '\e]133;D;%s\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then PS1=$'%{\e]133;B\e\\%}'"$PS1"; fi; printf '\e]133;A\e\\'; }
    _tunara_r_preexec() { printf '\e]133;C;%s\e\\' "$(_tunara_r_enc "$1")"; }
    add-zsh-hook precmd _tunara_r_precmd 2>/dev/null
    add-zsh-hook preexec _tunara_r_preexec 2>/dev/null
    _tunara_r_precmd
    if [ -n "__TUNARA_SESSION_ID__" ]; then
      _tunara_r_agent_emit() { printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' "$1" "__TUNARA_SESSION_ID__" "$2" "${3:-}"; }
      _tunara_r_agent_run() { local bin="$1" agent="$2"; shift 2; _tunara_r_agent_emit start "$agent"; command "$bin" "$@"; local ret=$?; _tunara_r_agent_emit exit "$agent" "$ret"; return $ret; }
      claude() { _tunara_r_agent_run claude CC "$@"; }
      droid() { _tunara_r_agent_run droid DR "$@"; }
      codex() { _tunara_r_agent_run codex CX "$@"; }
    fi
  fi
elif [ -n "$BASH_VERSION" ]; then
  if [ -z "$__TUNARA_REMOTE_LOADED" ]; then
    __TUNARA_REMOTE_LOADED=1
    _tunara_r_enc() { local LC_ALL=C s="$1" i c; for ((i=0;i<${#s};i++)); do c="${s:$i:1}"; case "$c" in [a-zA-Z0-9/._~-]) printf '%s' "$c";; *) printf '%%%02X' "'$c";; esac; done; }
    _tunara_r_prompt() { local r=$?; printf '\e]133;D;%s\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; printf '\e]133;A\e\\'; }
    _tunara_r_preexec() { [ -n "$COMP_LINE" ] && return; printf '\e]133;C;%s\e\\' "$(_tunara_r_enc "$BASH_COMMAND")"; }
    case "$PROMPT_COMMAND" in *_tunara_r_prompt*) ;; *) PROMPT_COMMAND="_tunara_r_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
    trap '_tunara_r_preexec' DEBUG
    if [ -n "__TUNARA_SESSION_ID__" ]; then
      _tunara_r_agent_emit() { printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' "$1" "__TUNARA_SESSION_ID__" "$2" "${3:-}"; }
      _tunara_r_agent_run() { local bin="$1" agent="$2"; shift 2; _tunara_r_agent_emit start "$agent"; command "$bin" "$@"; local ret=$?; _tunara_r_agent_emit exit "$agent" "$ret"; return $ret; }
      claude() { _tunara_r_agent_run claude CC "$@"; }
      droid() { _tunara_r_agent_run droid DR "$@"; }
      codex() { _tunara_r_agent_run codex CX "$@"; }
    fi
  fi
fi
