# conduit-shell-integration (fish)
# Emits OSC 7 for cwd, OSC 133 for command boundaries, and OSC 777 for agent lifecycle.

if not set -q __CONDUIT_HOOKS_LOADED
  set -g __CONDUIT_HOOKS_LOADED 1

  function _conduit_urlencode --argument-names value
    string escape --style=url -- $value
  end

  function _conduit_precmd --on-event fish_prompt
    set -l ret $status
    printf '\e]133;D;%s\e\\' $ret
    printf '\e]7;file://localhost%s\e\\' (_conduit_urlencode $PWD)
    printf '\e]133;A\e\\'
  end

  function _conduit_preexec --on-event fish_preexec
    if test (count $argv) -gt 0
      printf '\e]133;C;%s\e\\' (_conduit_urlencode $argv[1])
    else
      printf '\e]133;C\e\\'
    end
  end

  _conduit_precmd
end

if set -q CONDUIT_SESSION_ID
  function _conduit_agent_osc --argument-names event agent code
    set -l code_value ""
    if set -q code
      set code_value $code
    end
    printf '\e]777;conduit-agent;%s;%s;%s;%s\e\\' $event $CONDUIT_SESSION_ID $agent $code_value
  end

  function _conduit_agent_emit --argument-names event agent code
    _conduit_agent_osc $event $agent $code
    if not set -q CONDUIT_HOOKS_SOCK
      return 0
    end
    if test -z "$CONDUIT_HOOKS_SOCK"
      return 0
    end
    if set -q code; and test -n "$code"
      printf '{"event":"%s","session":"%s","agent":"%s","code":%s}' $event $CONDUIT_SESSION_ID $agent $code | nc -U "$CONDUIT_HOOKS_SOCK" >/dev/null 2>&1; or true
    else
      printf '{"event":"%s","session":"%s","agent":"%s"}' $event $CONDUIT_SESSION_ID $agent | nc -U "$CONDUIT_HOOKS_SOCK" >/dev/null 2>&1; or true
    end
  end

  function _conduit_agent_run
    set -l real_bin $argv[1]
    set -l agent $argv[2]
    set -e argv[1]
    set -e argv[1]
    set -l sid $CONDUIT_SESSION_ID
    set -l sock $CONDUIT_HOOKS_SOCK
    set -l f /tmp/conduit-agent-$sid.json
    _conduit_agent_emit start $agent
    if test -n "$sock"
      printf '{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"idle\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U %s"}]}],"Stop":[{"hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"stop\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U %s"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"printf \'{\\"event\\":\\"idle\\",\\"session\\":\\"%s\\",\\"agent\\":\\"%s\\"}\' | nc -U %s"}]}]}}' $sid $agent $sock $sid $agent $sock $sid $agent $sock >$f
      command $real_bin --settings $f $argv
    else
      command $real_bin $argv
    end
    set -l ret $status
    _conduit_agent_emit exit $agent $ret
    rm -f $f 2>/dev/null
    return $ret
  end

  function _conduit_agent_plain_run
    set -l real_bin $argv[1]
    set -l agent $argv[2]
    set -e argv[1]
    set -e argv[1]
    _conduit_agent_emit start $agent
    command $real_bin $argv
    set -l ret $status
    _conduit_agent_emit exit $agent $ret
    return $ret
  end

  function claude
    _conduit_agent_run claude CC $argv
  end

  function droid
    _conduit_agent_run droid DR $argv
  end

  function codex
    _conduit_agent_plain_run codex CX $argv
  end
end
