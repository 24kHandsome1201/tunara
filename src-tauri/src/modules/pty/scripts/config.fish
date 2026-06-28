# tunara-shell-integration (fish)
# Emits OSC 7 for cwd, OSC 133 for command boundaries, and OSC 777 for agent lifecycle.

if not set -q __TUNARA_HOOKS_LOADED
  set -g __TUNARA_HOOKS_LOADED 1

  function _tunara_urlencode --argument-names value
    string escape --style=url -- $value
  end

  function _tunara_precmd --on-event fish_prompt
    set -l ret $status
    printf '\e]133;D;%s\e\\' $ret
    printf '\e]7;file://localhost%s\e\\' (_tunara_urlencode $PWD)
    printf '\e]133;A\e\\'
  end

  function _tunara_preexec --on-event fish_preexec
    if test (count $argv) -gt 0
      printf '\e]133;C;%s\e\\' (_tunara_urlencode $argv[1])
    else
      printf '\e]133;C\e\\'
    end
  end

  _tunara_precmd
end

if set -q TUNARA_SESSION_ID
  function _tunara_agent_osc --argument-names event agent code
    set -l code_value ""
    if set -q code
      set code_value $code
    end
    printf '\e]777;tunara-agent;%s;%s;%s;%s\e\\' $event $TUNARA_SESSION_ID $agent $code_value
  end

  function _tunara_agent_emit --argument-names event agent code
    _tunara_agent_osc $event $agent $code
    if not set -q TUNARA_HOOKS_SOCK
      return 0
    end
    if test -z "$TUNARA_HOOKS_SOCK"
      return 0
    end
    if set -q code; and test -n "$code"
      printf '{"event":"%s","session":"%s","agent":"%s","code":%s}' $event $TUNARA_SESSION_ID $agent $code | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1; or true
    else
      printf '{"event":"%s","session":"%s","agent":"%s"}' $event $TUNARA_SESSION_ID $agent | nc -U "$TUNARA_HOOKS_SOCK" >/dev/null 2>&1; or true
    end
  end

  # Writes a Claude-Code --settings file pointing each lifecycle hook at the
  # host-provided agent-hook.sh helper. That helper reads the hook's stdin JSON,
  # extracts the agent's real session_id, and relays it as agent_session_id — so
  # resume uses the agent's own id instead of scraping the typed command line.
  # The hook command is just `sh <helper> <event> <agent> <sid>`, so no quoting
  # has to survive the nested settings JSON. Prints the settings path, or nothing.
  function _tunara_agent_write_hooks --argument-names sid agent config_dir
    test -n "$config_dir"; and test -d "$config_dir"; or return 1
    set -l helper "$config_dir/agent-hook.sh"
    test -f "$helper"; or return 1
    set -l sf (mktemp "$config_dir/tunara-agent-$sid.XXXXXX.json" 2>/dev/null); or return 1
    chmod 600 "$sf" 2>/dev/null; or true
    set -l idle "sh $helper idle $agent $sid"
    set -l stop "sh $helper stop $agent $sid"
    printf '{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"%s"}]}],"Stop":[{"hooks":[{"type":"command","command":"%s"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"%s"}]}]}}' $idle $stop $idle >$sf
    printf '%s' $sf
    return 0
  end

  function _tunara_agent_run
    set -l real_bin $argv[1]
    set -l agent $argv[2]
    set -e argv[1]
    set -e argv[1]
    set -l sid $TUNARA_SESSION_ID
    set -l sock $TUNARA_HOOKS_SOCK
    set -l config_dir ""
    if set -q TUNARA_AGENT_CONFIG_DIR
      set config_dir $TUNARA_AGENT_CONFIG_DIR
    end
    set -l sf ""
    _tunara_agent_emit start $agent
    if test -n "$sock"
      set sf (_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")
    end
    if test -n "$sf"
      command $real_bin --settings $sf $argv
    else
      command $real_bin $argv
    end
    set -l ret $status
    _tunara_agent_emit exit $agent $ret
    rm -f $sf 2>/dev/null
    return $ret
  end

  function _tunara_agent_plain_run
    set -l real_bin $argv[1]
    set -l agent $argv[2]
    set -e argv[1]
    set -e argv[1]
    _tunara_agent_emit start $agent
    command $real_bin $argv
    set -l ret $status
    _tunara_agent_emit exit $agent $ret
    return $ret
  end

  function claude
    _tunara_agent_run claude CC $argv
  end

  function droid
    _tunara_agent_run droid DR $argv
  end

  function codex
    _tunara_agent_plain_run codex CX $argv
  end
end
