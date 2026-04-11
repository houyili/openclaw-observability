#!/bin/bash
# Manage ngrok tunnel for observability-v2 dashboard.
# Usage: tunnel-ngrok.sh {start|stop|status|url}
#
# Uses a fixed ngrok domain (configured via install_ngrok.py).
# Token stored in macOS Keychain, domain stored in .env.

set -e

NGROK_BIN="$HOME/.local/bin/ngrok"
LOG_DIR="$HOME/.openclaw/logs/observability-v2"
PID_FILE="$LOG_DIR/ngrok.pid"
ENV_FILE="$HOME/.openclaw/extensions/observability-v2/.env"
DASHBOARD_PORT=18902

mkdir -p "$LOG_DIR"

# Read config from .env
DOMAIN=""
TOKEN=""
FIXED_URL=""
if [ -f "$ENV_FILE" ]; then
  DOMAIN=$(grep '^OBS_NGROK_DOMAIN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  TOKEN=$(grep '^OBS_AUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  FIXED_URL=$(grep '^OBS_FIXED_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

do_start() {
  if [ -z "$DOMAIN" ]; then
    echo '{"status":"error","error":"No OBS_NGROK_DOMAIN in .env. Run: python3 scripts/install_ngrok.py"}'
    exit 1
  fi

  if is_running; then
    echo "{\"status\":\"already_running\",\"url\":\"https://${DOMAIN}\"}"
    return
  fi

  # Start ngrok in background
  "$NGROK_BIN" http --domain="$DOMAIN" "$DASHBOARD_PORT" --log=stdout > "$LOG_DIR/ngrok.log" 2>&1 &
  echo $! > "$PID_FILE"

  # Wait for tunnel to be ready
  for i in $(seq 1 15); do
    if curl -s --max-time 3 "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
      echo "{\"status\":\"started\",\"url\":\"https://${DOMAIN}\"}"
      return
    fi
    sleep 1
  done

  echo "{\"status\":\"started\",\"url\":\"https://${DOMAIN}\",\"note\":\"may still be connecting\"}"
}

do_stop() {
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo '{"status":"stopped"}'
  else
    rm -f "$PID_FILE"
    echo '{"status":"not_running"}'
  fi
}

do_status() {
  if is_running; then
    echo "{\"status\":\"running\",\"url\":\"https://${DOMAIN}\"}"
  else
    rm -f "$PID_FILE"
    echo '{"status":"not_running"}'
  fi
}

do_url() {
  if [ -z "$DOMAIN" ]; then
    echo '{"status":"error","error":"Not configured. Run: python3 scripts/install_ngrok.py"}'
    return
  fi

  # Start if not running
  if ! is_running; then
    do_start >/dev/null 2>&1
    sleep 3
  fi

  URL="https://${DOMAIN}"
  if [ -n "$TOKEN" ]; then
    echo "{\"status\":\"ok\",\"url\":\"${URL}/?token=${TOKEN}\"}"
  else
    echo "{\"status\":\"ok\",\"url\":\"${URL}\"}"
  fi
}

case "${1:-url}" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  url)    do_url ;;
  *)      echo "Usage: $0 {start|stop|status|url}"; exit 1 ;;
esac
