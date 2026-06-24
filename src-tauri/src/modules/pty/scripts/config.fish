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
    set -l f ""
    _tunara_agent_emit start $agent
    if test -n "$sock"; and test -n "$config_dir"; and test -d "$config_dir"
      set f (mktemp "$config_dir/tunara-agent-$sid.XXXXXX.json" 2>/dev/null)
    end
    if test -n "$f"
      chmod 600 "$f" 2>/dev/null; or true
      printf '{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"idle\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U \\"$TUNARA_HOOKS_SOCK\\""}]}],"Stop":[{"hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"stop\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U \\"$TUNARA_HOOKS_SOCK\\""}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"idle\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U \\"$TUNARA_HOOKS_SOCK\\""}]}]}}' $sid $agent $sid $agent $sid $agent >$f
      command $real_bin --settings $f $argv
    else
      command $real_bin $argv
    end
    set -l ret $status
    _tunara_agent_emit exit $agent $ret
    rm -f $f 2>/dev/null
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
