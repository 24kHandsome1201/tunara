#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
STATE_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache/tunara/runtime}"
LOG_FILE="$STATE_DIR/keep-mac-awake.log"
LABEL="dev.tunara.keep-awake"
CAFFEINATE_ARGS=(-dimsu -t 2147483647)

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

is_running() {
  launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1
}

service_pid() {
  launchctl print "gui/$UID/$LABEL" 2>/dev/null \
    | awk '/^[[:space:]]*pid = / { print $3; exit }'
}

start_awake() {
  if is_running; then
    echo "Mac 防休眠已运行，PID $(service_pid)"
    return
  fi

  launchctl submit -l "$LABEL" -o "$LOG_FILE" -e "$LOG_FILE" -- \
    /usr/bin/caffeinate "${CAFFEINATE_ARGS[@]}"
  sleep 0.2
  if ! is_running; then
    echo "启动失败，日志：$LOG_FILE" >&2
    exit 1
  fi
  echo "已阻止锁屏、关屏和空闲睡眠，PID $(service_pid)"
}

stop_awake() {
  if ! is_running; then
    echo "Mac 防休眠未运行"
    return
  fi

  launchctl remove "$LABEL"
  echo "已恢复系统原有的锁屏和休眠策略"
}

show_status() {
  if is_running; then
    echo "Mac 防休眠运行中，PID $(service_pid)"
    pmset -g assertions | grep -E 'PreventUserIdleDisplaySleep|PreventUserIdleSystemSleep|UserIsActive' || true
  else
    echo "Mac 防休眠未运行"
    return 1
  fi
}

case "$ACTION" in
  start) start_awake ;;
  stop) stop_awake ;;
  restart) stop_awake; start_awake ;;
  status) show_status ;;
  foreground) exec /usr/bin/caffeinate "${CAFFEINATE_ARGS[@]}" ;;
  *)
    echo "用法：$0 [start|stop|restart|status|foreground]" >&2
    exit 2
    ;;
esac
