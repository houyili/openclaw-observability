#!/bin/bash
# Manage ngrok tunnel for observability-v2 dashboard.
# Usage: tunnel-ngrok.sh {start|stop|status|url}
#
# Uses a fixed ngrok domain (configured via install_ngrok.py).
# Token stored in macOS Keychain, domain stored in .env.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/env.sh"

NGROK_BIN="${NGROK_BIN:-$HOME/.local/bin/ngrok}"
LOG_DIR="$HOME/.openclaw/logs/observability-v2"
PID_FILE="$LOG_DIR/ngrok.pid"
ENV_FILE="${OBS_ENV_FILE:-$(obs_env_file)}"
DASHBOARD_PORT=18902

mkdir -p "$LOG_DIR"

# Read config from .env
DOMAIN="${OBS_NGROK_DOMAIN:-$(obs_read_env_value OBS_NGROK_DOMAIN "$ENV_FILE")}"
TOKEN="${OBS_AUTH_TOKEN:-$(obs_read_env_value OBS_AUTH_TOKEN "$ENV_FILE")}"
FIXED_URL="${OBS_FIXED_URL:-$(obs_read_env_value OBS_FIXED_URL "$ENV_FILE")}"
ALLOW_UNAUTH="${OBS_ALLOW_UNAUTH_TUNNEL:-$(obs_read_env_value OBS_ALLOW_UNAUTH_TUNNEL "$ENV_FILE")}"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

allow_unauth_tunnel() {
  [ "$ALLOW_UNAUTH" = "1" ] || [ "$ALLOW_UNAUTH" = "true" ] || [ "$ALLOW_UNAUTH" = "yes" ]
}

require_share_auth() {
  if [ -z "$TOKEN" ] && ! allow_unauth_tunnel; then
    echo '{"status":"error","error":"Refusing to expose dashboard without OBS_AUTH_TOKEN. Set OBS_AUTH_TOKEN or explicitly set OBS_ALLOW_UNAUTH_TUNNEL=1."}'
    return 1
  fi
}

share_url() {
  url="$1"
  if [ -n "$TOKEN" ]; then
    printf '%s/#token=%s' "$url" "$TOKEN"
  else
    printf '%s' "$url"
  fi
}

json_url_field() {
  url="$1"
  shared=$(share_url "$url")
  if [ -n "$TOKEN" ]; then
    printf '"url":"%s"' "$shared"
  else
    printf '"url":"%s","warning":"unauthenticated tunnel explicitly allowed"' "$shared"
  fi
}

do_start() {
  require_share_auth || exit 1

  if [ -z "$DOMAIN" ]; then
    echo '{"status":"error","error":"No OBS_NGROK_DOMAIN in .env. Run: python3 scripts/install_ngrok.py"}'
    exit 1
  fi

  if is_running; then
    echo "{\"status\":\"already_running\",$(json_url_field "https://${DOMAIN}")}"
    return
  fi

  # Start ngrok in background
  "$NGROK_BIN" http --domain="$DOMAIN" "$DASHBOARD_PORT" --log=stdout > "$LOG_DIR/ngrok.log" 2>&1 &
  echo $! > "$PID_FILE"

  # Wait for tunnel to be ready
  for i in $(seq 1 15); do
    if curl -s --max-time 3 "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
      echo "{\"status\":\"started\",$(json_url_field "https://${DOMAIN}")}"
      return
    fi
    sleep 1
  done

  echo "{\"status\":\"started\",$(json_url_field "https://${DOMAIN}"),\"note\":\"may still be connecting\"}"
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
    if require_share_auth >/dev/null; then
      echo "{\"status\":\"running\",$(json_url_field "https://${DOMAIN}")}"
    else
      echo '{"status":"running","url":"redacted","warning":"set OBS_AUTH_TOKEN or OBS_ALLOW_UNAUTH_TUNNEL=1 to reveal public URL"}'
    fi
  else
    rm -f "$PID_FILE"
    echo '{"status":"not_running"}'
  fi
}

do_url() {
  require_share_auth || return

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
  echo "{\"status\":\"ok\",$(json_url_field "$URL")}"
}

case "${1:-url}" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  url)    do_url ;;
  *)      echo "Usage: $0 {start|stop|status|url}"; exit 1 ;;
esac
