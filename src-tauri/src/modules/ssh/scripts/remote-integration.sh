# tunara remote shell integration (Phase 4, opt-in).
#
# Injected as the first input to a remote interactive shell. Installs OSC 7
# (cwd) + OSC 133 A/B/C/D (prompt/command boundaries) hooks for bash or zsh so
# the host gets remote cwd + command detection + agent detection — the same
# signals local sessions emit. Self-guards against double-install and degrades
# silently on unsupported shells. Kept on ONE logical line per shell so it can
# be sent as a single command without a heredoc.
#
# This runs INSIDE the user's already-started remote shell, so it must not
# disturb their environment beyond adding precmd/preexec hooks.

if [ -n "$ZSH_VERSION" ]; then
  if [ -z "$__TUNARA_REMOTE_LOADED" ]; then
    __TUNARA_REMOTE_LOADED=1
    autoload -Uz add-zsh-hook 2>/dev/null
    _tunara_r_enc() { local LC_ALL=C s="$1" i c; for ((i=1;i<=${#s};i++)); do c="${s[i]}"; case "$c" in [a-zA-Z0-9/._~-]) printf '%s' "$c";; *) printf '%%%02X' "'$c";; esac; done; }
    _tunara_r_precmd() { local r=$?; printf '\e]133;D;%s\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; printf '\e]133;A\e\\'; }
    _tunara_r_preexec() { printf '\e]133;C;%s\e\\' "$(_tunara_r_enc "$1")"; }
    add-zsh-hook precmd _tunara_r_precmd 2>/dev/null
    add-zsh-hook preexec _tunara_r_preexec 2>/dev/null
    _tunara_r_precmd
  fi
elif [ -n "$BASH_VERSION" ]; then
  if [ -z "$__TUNARA_REMOTE_LOADED" ]; then
    __TUNARA_REMOTE_LOADED=1
    _tunara_r_enc() { local LC_ALL=C s="$1" i c; for ((i=0;i<${#s};i++)); do c="${s:$i:1}"; case "$c" in [a-zA-Z0-9/._~-]) printf '%s' "$c";; *) printf '%%%02X' "'$c";; esac; done; }
    _tunara_r_prompt() { local r=$?; printf '\e]133;D;%s\e\\' "$r"; printf '\e]7;file://localhost%s\e\\' "$(_tunara_r_enc "$PWD")"; printf '\e]133;A\e\\'; }
    _tunara_r_preexec() { [ -n "$COMP_LINE" ] && return; printf '\e]133;C;%s\e\\' "$(_tunara_r_enc "$BASH_COMMAND")"; }
    case "$PROMPT_COMMAND" in *_tunara_r_prompt*) ;; *) PROMPT_COMMAND="_tunara_r_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
    trap '_tunara_r_preexec' DEBUG
  fi
fi
