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

  # Writes one private runtime containing a Droid settings file and a Claude
  # plugin so Claude hooks compose with any user --settings argument.
  # host-provided agent-hook.sh helper. That helper reads the hook's stdin JSON,
  # extracts the agent's real session_id, and relays it as agent_session_id — so
  # resume uses the agent's own id instead of scraping the typed command line.
  # The helper path stays behind the inherited config-dir env so spaces and
  # quotes remain valid inside settings JSON. Prints the runtime path, or nothing.
  function _tunara_agent_write_hooks --argument-names sid agent config_dir
    test -n "$config_dir"; and test -d "$config_dir"; or return 1
    set -l helper "$config_dir/agent-hook.sh"
    test -f "$helper"; or return 1
    set -l runtime (mktemp -d "$config_dir/tunara-agent-$sid.XXXXXX" 2>/dev/null); or return 1
    chmod 700 "$runtime" 2>/dev/null; or begin; rm -rf "$runtime"; return 1; end
    mkdir -p "$runtime/.claude-plugin" "$runtime/hooks"; or begin; rm -rf "$runtime"; return 1; end
    set -l sf "$runtime/settings.json"
    set -l helper_command 'sh \"$TUNARA_AGENT_CONFIG_DIR/agent-hook.sh\"'
    set -l idle "$helper_command idle $agent $sid"
    set -l busy "$helper_command busy $agent $sid"
    set -l wait "$helper_command wait $agent $sid"
    set -l stop "$helper_command stop $agent $sid"
    printf '{"hooks":{"SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":"%s"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"%s"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"%s"}]}],"PermissionRequest":[{"hooks":[{"type":"command","command":"%s"}]}],"Stop":[{"hooks":[{"type":"command","command":"%s"}]}],"StopFailure":[{"hooks":[{"type":"command","command":"%s"}]}],"Notification":[{"matcher":"idle_prompt","hooks":[{"type":"command","command":"%s"}]}]}}' $idle $busy $busy $wait $stop $stop $idle >$sf
    cp "$sf" "$runtime/hooks/hooks.json"; or begin; rm -rf "$runtime"; return 1; end
    printf '%s\n' '{"name":"tunara-lifecycle","description":"Tunara session lifecycle bridge","version":"1.0.0"}' > "$runtime/.claude-plugin/plugin.json"
    chmod 600 "$sf" "$runtime/hooks/hooks.json" "$runtime/.claude-plugin/plugin.json" 2>/dev/null; or true
    printf '%s' $runtime
    return 0
  end

  function _tunara_agent_run
    set -l real_bin $argv[1]
    set -l agent $argv[2]
    set -e argv[1]
    set -e argv[1]
    set -l sid $TUNARA_SESSION_ID
    set -l config_dir ""
    if set -q TUNARA_AGENT_CONFIG_DIR
      set config_dir $TUNARA_AGENT_CONFIG_DIR
    end
    set -l runtime ""
    _tunara_agent_emit start $agent
    set runtime (_tunara_agent_write_hooks "$sid" "$agent" "$config_dir")
    if test -n "$runtime"; and test "$real_bin" = claude
      command $real_bin --plugin-dir $runtime $argv
    else if test -n "$runtime"
      set -l user_settings ""
      set -l has_user_settings 0
      set -l forwarded
      set -l i 1
      while test $i -le (count $argv)
        set -l arg $argv[$i]
        if test "$arg" = --settings; and test (math $i + 1) -le (count $argv)
          set i (math $i + 1)
          set user_settings $argv[$i]
          set has_user_settings 1
        else if string match -q -- '--settings=*' "$arg"
          set user_settings (string replace -r '^--settings=' '' -- "$arg")
          set has_user_settings 1
        else
          set -a forwarded "$arg"
        end
        set i (math $i + 1)
      end
      set -l settings "$runtime/settings.json"
      if test "$has_user_settings" = 1
        set -l merged "$runtime/merged-settings.json"
        if sh "$config_dir/agent-hook.sh" merge-settings "$user_settings" "$settings" "$merged" 2>/dev/null
          set settings $merged
        else
          set settings $user_settings
        end
      end
      command $real_bin --settings $settings $forwarded
    else
      command $real_bin $argv
    end
    set -l ret $status
    _tunara_agent_emit exit $agent $ret
    if test -n "$runtime"
      rm -rf "$runtime"
    end
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
