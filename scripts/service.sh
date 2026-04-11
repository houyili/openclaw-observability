#!/bin/bash
# Manage the observability-v2 launchd service
# Usage: service.sh {install|uninstall|start|stop|restart|status|logs}

set -e

PLIST_NAME="com.openclaw.observability-v2"
SRC_PLIST="$(cd "$(dirname "$0")/.." && pwd)/${PLIST_NAME}.plist"
DST_PLIST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/.openclaw/logs/observability-v2"

case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    cp "$SRC_PLIST" "$DST_PLIST"
    echo "Installed: $DST_PLIST"
    launchctl load "$DST_PLIST" 2>/dev/null || true
    echo "Service loaded and will start automatically on login."
    echo "  Dashboard: http://127.0.0.1:18902"
    echo "  Logs:      $LOG_DIR/stdout.log"
    ;;

  uninstall)
    launchctl unload "$DST_PLIST" 2>/dev/null || true
    rm -f "$DST_PLIST"
    echo "Service uninstalled."
    ;;

  start)
    if [ ! -f "$DST_PLIST" ]; then
      echo "Not installed. Run: $0 install"
      exit 1
    fi
    launchctl load "$DST_PLIST" 2>/dev/null || true
    launchctl start "$PLIST_NAME" 2>/dev/null || true
    echo "Started. Dashboard: http://127.0.0.1:18902"
    ;;

  stop)
    launchctl stop "$PLIST_NAME" 2>/dev/null || true
    echo "Stopped."
    ;;

  restart)
    launchctl stop "$PLIST_NAME" 2>/dev/null || true
    sleep 1
    launchctl start "$PLIST_NAME" 2>/dev/null || true
    echo "Restarted. Dashboard: http://127.0.0.1:18902"
    ;;

  status)
    if [ ! -f "$DST_PLIST" ]; then
      echo "Not installed. Run: $0 install"
    elif curl -s --max-time 10 http://127.0.0.1:18902/healthz >/dev/null 2>&1; then
      echo "Running"
      echo "  Dashboard: http://127.0.0.1:18902"
      curl -s http://127.0.0.1:18902/healthz 2>/dev/null
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
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
