#!/bin/bash
# Manage the OpenClaw Observability user service.
# Usage: service.sh {generate-plist|check|generate-systemd|check-systemd|install|uninstall|start|stop|restart|status|logs}

set -e

PLIST_NAME="com.openclaw.observability-v2"
SYSTEMD_NAME="openclaw-observability"
SYSTEMD_UNIT="${SYSTEMD_NAME}.service"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_PLIST="${OBS_SERVICE_PLIST:-$PROJECT_DIR/${PLIST_NAME}.plist}"
TPL_PLIST="$PROJECT_DIR/${PLIST_NAME}.plist.template"
DST_PLIST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
SRC_SYSTEMD="${OBS_SYSTEMD_SERVICE:-$PROJECT_DIR/${SYSTEMD_UNIT}}"
DST_SYSTEMD="$HOME/.config/systemd/user/${SYSTEMD_UNIT}"
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

require_linux() {
  if [ "$(uname -s)" != "Linux" ]; then
    echo "systemd user service management is Linux-only."
    echo "Use docs/install/macos.md for macOS launchd startup."
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

generate_systemd() {
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "Node executable not found. Set NODE_BIN=/absolute/path/to/node."
    exit 1
  fi
  cat > "$SRC_SYSTEMD" <<EOF
[Unit]
Description=OpenClaw Observability
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN --experimental-sqlite --experimental-strip-types --no-warnings $PROJECT_DIR/src/index.ts
Restart=always
RestartSec=5
Environment=PATH=$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
  chmod 600 "$SRC_SYSTEMD"
  echo "Generated: $SRC_SYSTEMD"
}

check_systemd() {
  if [ ! -f "$SRC_SYSTEMD" ]; then
    echo "Generated systemd unit missing: $SRC_SYSTEMD"
    echo "Run: $0 generate-systemd"
    return 1
  fi
  if grep -q '__[A-Z_][A-Z_]*__' "$SRC_SYSTEMD"; then
    echo "Generated systemd unit still contains placeholders."
    echo "Run: $0 generate-systemd"
    return 1
  fi
  if [ -n "$NODE_BIN" ] && [ ! -x "$NODE_BIN" ]; then
    echo "Node executable is not executable: $NODE_BIN"
    return 1
  fi
  echo "Systemd unit OK: $SRC_SYSTEMD"
}

systemctl_user() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found. Use foreground mode: npm run start"
    exit 1
  fi
  systemctl --user "$@"
}

case "${1:-status}" in
  generate-plist)
    generate_plist
    ;;

  check)
    check_plist
    ;;

  generate-systemd)
    generate_systemd
    ;;

  check-systemd)
    check_systemd
    ;;

  install)
    mkdir -p "$LOG_DIR"
    if [ "$(uname -s)" = "Darwin" ]; then
      require_macos
      mkdir -p "$HOME/Library/LaunchAgents"
      if [ ! -f "$SRC_PLIST" ]; then
        generate_plist
      fi
      check_plist >/dev/null
      cp "$SRC_PLIST" "$DST_PLIST"
      echo "Installed: $DST_PLIST"
      launchctl unload "$DST_PLIST" 2>/dev/null || true
      launchctl load "$DST_PLIST" 2>/dev/null || true
      echo "Service loaded and will start automatically on login."
    elif [ "$(uname -s)" = "Linux" ]; then
      require_linux
      mkdir -p "$(dirname "$DST_SYSTEMD")"
      if [ ! -f "$SRC_SYSTEMD" ]; then
        generate_systemd
      fi
      check_systemd >/dev/null
      cp "$SRC_SYSTEMD" "$DST_SYSTEMD"
      echo "Installed: $DST_SYSTEMD"
      systemctl_user daemon-reload
      systemctl_user enable --now "$SYSTEMD_UNIT"
      echo "Service enabled and started as a systemd user service."
    else
      echo "Unsupported OS for service install: $(uname -s)"
      exit 1
    fi
    echo "  Dashboard: $DASHBOARD_URL"
    echo "  Logs:      $LOG_DIR/stdout.log"
    ;;

  uninstall)
    if [ "$(uname -s)" = "Darwin" ]; then
      require_macos
      launchctl unload "$DST_PLIST" 2>/dev/null || true
      rm -f "$DST_PLIST"
    elif [ "$(uname -s)" = "Linux" ]; then
      require_linux
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now "$SYSTEMD_UNIT" 2>/dev/null || true
        systemctl --user daemon-reload 2>/dev/null || true
      fi
      rm -f "$DST_SYSTEMD"
    fi
    echo "Service uninstalled."
    ;;

  start)
    if [ "$(uname -s)" = "Darwin" ]; then
      require_macos
      if [ ! -f "$DST_PLIST" ]; then
        echo "Not installed. Run: $0 install"
        exit 1
      fi
      launchctl load "$DST_PLIST" 2>/dev/null || true
      launchctl start "$PLIST_NAME" 2>/dev/null || true
    elif [ "$(uname -s)" = "Linux" ]; then
      require_linux
      systemctl_user start "$SYSTEMD_UNIT"
    fi
    echo "Started. Dashboard: $DASHBOARD_URL"
    ;;

  stop)
    if [ "$(uname -s)" = "Darwin" ]; then
      require_macos
      launchctl stop "$PLIST_NAME" 2>/dev/null || true
    elif [ "$(uname -s)" = "Linux" ]; then
      require_linux
      systemctl_user stop "$SYSTEMD_UNIT"
    fi
    echo "Stopped."
    ;;

  restart)
    if [ "$(uname -s)" = "Darwin" ]; then
      require_macos
      launchctl stop "$PLIST_NAME" 2>/dev/null || true
      sleep 1
      launchctl start "$PLIST_NAME" 2>/dev/null || true
    elif [ "$(uname -s)" = "Linux" ]; then
      require_linux
      systemctl_user restart "$SYSTEMD_UNIT"
    fi
    echo "Restarted. Dashboard: $DASHBOARD_URL"
    ;;

  status)
    if curl -s --max-time 10 "$DASHBOARD_URL/healthz" >/dev/null 2>&1; then
      echo "Running"
      echo "  Dashboard: $DASHBOARD_URL"
      curl -s "$DASHBOARD_URL/healthz" 2>/dev/null
    else
      if [ "$(uname -s)" = "Darwin" ] && [ ! -f "$DST_PLIST" ]; then
        echo "Not installed. Run: $0 install"
        exit 0
      fi
      if [ "$(uname -s)" = "Linux" ] && [ ! -f "$DST_SYSTEMD" ]; then
        echo "Not installed. Run: $0 install"
        exit 0
      fi
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
    echo "Usage: $0 {generate-plist|check|generate-systemd|check-systemd|install|uninstall|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
