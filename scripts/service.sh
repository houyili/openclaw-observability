#!/bin/bash
# Manage the observability-v2 launchd service
# Usage: service.sh {generate-plist|check|install|uninstall|start|stop|restart|status|logs}

set -e

PLIST_NAME="com.openclaw.observability-v2"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_PLIST="${OBS_SERVICE_PLIST:-$PROJECT_DIR/${PLIST_NAME}.plist}"
TPL_PLIST="$PROJECT_DIR/${PLIST_NAME}.plist.template"
DST_PLIST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/.openclaw/logs/observability-v2"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
DASHBOARD_URL="http://127.0.0.1:18902"

require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "launchd service management is macOS-only."
    echo "Use docs/install/linux.md for systemd/manual Linux startup."
    exit 1
  fi
}

generate_plist() {
  if [ ! -f "$TPL_PLIST" ]; then
    echo "Missing template: $TPL_PLIST"
    exit 1
  fi
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "Node executable not found. Set NODE_BIN=/absolute/path/to/node."
    exit 1
  fi
  sed "s|__HOME__|$HOME|g; s|__NODE__|$NODE_BIN|g" "$TPL_PLIST" > "$SRC_PLIST"
  chmod 600 "$SRC_PLIST"
  echo "Generated: $SRC_PLIST"
}

check_plist() {
  if [ ! -f "$SRC_PLIST" ]; then
    echo "Generated plist missing: $SRC_PLIST"
    echo "Run: $0 generate-plist"
    return 1
  fi
  if grep -q '__[A-Z_][A-Z_]*__' "$SRC_PLIST"; then
    echo "Generated plist still contains placeholders."
    echo "Run: $0 generate-plist"
    return 1
  fi
  if [ -n "$NODE_BIN" ] && [ ! -x "$NODE_BIN" ]; then
    echo "Node executable is not executable: $NODE_BIN"
    return 1
  fi
  echo "Service plist OK: $SRC_PLIST"
}

case "${1:-status}" in
  generate-plist)
    generate_plist
    ;;

  check)
    check_plist
    ;;

  install)
    require_macos
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    if [ ! -f "$SRC_PLIST" ]; then
      generate_plist
    fi
    check_plist >/dev/null
    cp "$SRC_PLIST" "$DST_PLIST"
    echo "Installed: $DST_PLIST"
    launchctl load "$DST_PLIST" 2>/dev/null || true
    echo "Service loaded and will start automatically on login."
    echo "  Dashboard: $DASHBOARD_URL"
    echo "  Logs:      $LOG_DIR/stdout.log"
    ;;

  uninstall)
    require_macos
    launchctl unload "$DST_PLIST" 2>/dev/null || true
    rm -f "$DST_PLIST"
    echo "Service uninstalled."
    ;;

  start)
    require_macos
    if [ ! -f "$DST_PLIST" ]; then
      echo "Not installed. Run: $0 install"
      exit 1
    fi
    launchctl load "$DST_PLIST" 2>/dev/null || true
    launchctl start "$PLIST_NAME" 2>/dev/null || true
    echo "Started. Dashboard: $DASHBOARD_URL"
    ;;

  stop)
    require_macos
    launchctl stop "$PLIST_NAME" 2>/dev/null || true
    echo "Stopped."
    ;;

  restart)
    require_macos
    launchctl stop "$PLIST_NAME" 2>/dev/null || true
    sleep 1
    launchctl start "$PLIST_NAME" 2>/dev/null || true
    echo "Restarted. Dashboard: $DASHBOARD_URL"
    ;;

  status)
    if [ ! -f "$DST_PLIST" ]; then
      echo "Not installed. Run: $0 install"
    elif curl -s --max-time 10 "$DASHBOARD_URL/healthz" >/dev/null 2>&1; then
      echo "Running"
      echo "  Dashboard: $DASHBOARD_URL"
      curl -s "$DASHBOARD_URL/healthz" 2>/dev/null
    else
      echo "Installed but not responding. Check logs: $0 logs"
    fi
    ;;

  logs)
    echo "=== dashboard stdout ==="
    tail -20 "$LOG_DIR/stdout.log" 2>/dev/null || echo "(no log)"
    echo ""
    echo "=== dashboard stderr ==="
    tail -10 "$LOG_DIR/stderr.log" 2>/dev/null || echo "(no log)"
    echo ""
    echo "=== ngrok tunnel ==="
    tail -10 "$LOG_DIR/ngrok-service.log" 2>/dev/null || echo "(no log)"
    ;;

  *)
    echo "Usage: $0 {generate-plist|check|install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
