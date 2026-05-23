#!/bin/bash
# Manage cloudflared tunnel for observability-v2 dashboard.
# Usage: tunnel.sh {start|stop|status|url}
#
# Starts a Cloudflare Quick Tunnel, extracts the public URL,
# and writes it to tunnel-url.txt for the skill to read.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/env.sh"

CLOUDFLARED="${CLOUDFLARED_BIN:-$(which cloudflared 2>/dev/null || echo "$HOME/.local/bin/cloudflared")}"
ENV_FILE="${OBS_ENV_FILE:-$(obs_env_file)}"
LOG_DIR="$HOME/.openclaw/logs/observability-v2"
PID_FILE="$LOG_DIR/tunnel.pid"
URL_FILE="$LOG_DIR/tunnel-url.txt"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
DASHBOARD_PORT=18902
TIMEOUT=20
TOKEN="${OBS_AUTH_TOKEN:-$(obs_read_env_value OBS_AUTH_TOKEN "$ENV_FILE")}"
ALLOW_UNAUTH="${OBS_ALLOW_UNAUTH_TUNNEL:-$(obs_read_env_value OBS_ALLOW_UNAUTH_TUNNEL "$ENV_FILE")}"

mkdir -p "$LOG_DIR"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

extract_url() {
  # cloudflared logs the tunnel URL to stderr
  grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1
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

  if ! command -v "$CLOUDFLARED" >/dev/null 2>&1; then
    echo '{"status":"error","error":"cloudflared not installed. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ or set CLOUDFLARED_BIN."}'
    exit 1
  fi

  # Check if dashboard is running
  if ! curl -s --max-time 3 "http://127.0.0.1:${DASHBOARD_PORT}/healthz" >/dev/null 2>&1; then
    echo '{"status":"error","error":"Dashboard not running on port '$DASHBOARD_PORT'. Start it first: sh scripts/service.sh install"}'
    exit 1
  fi

  if is_running; then
    URL=$(extract_url)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      echo "{\"status\":\"already_running\",$(json_url_field "$URL")}"
      return
    fi
    # Running but no URL yet — kill and restart
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
  fi

  # Start cloudflared in background
  > "$TUNNEL_LOG"  # truncate log
  "$CLOUDFLARED" tunnel --url "http://127.0.0.1:${DASHBOARD_PORT}" \
    --no-autoupdate \
    > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$PID_FILE"

  # Wait for URL to appear in log (up to TIMEOUT seconds)
  for i in $(seq 1 "$TIMEOUT"); do
    URL=$(extract_url)
    if [ -n "$URL" ]; then
      echo "$URL" > "$URL_FILE"
      echo "{\"status\":\"started\",$(json_url_field "$URL"),\"pid\":$TUNNEL_PID}"
      return
    fi
    sleep 1
  done

  # Timeout
  echo "{\"status\":\"error\",\"error\":\"Tunnel started (PID $TUNNEL_PID) but URL not found within ${TIMEOUT}s. Check $TUNNEL_LOG\"}"
}

do_stop() {
  if is_running; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE" "$URL_FILE"
    echo '{"status":"stopped"}'
  else
    rm -f "$PID_FILE" "$URL_FILE"
    echo '{"status":"not_running"}'
  fi
}

do_status() {
  if is_running; then
    URL=$(cat "$URL_FILE" 2>/dev/null || extract_url)
    PID=$(cat "$PID_FILE")
    if [ -n "$URL" ]; then
      if require_share_auth >/dev/null; then
        echo "{\"status\":\"running\",$(json_url_field "$URL"),\"pid\":$PID}"
      else
        echo "{\"status\":\"running\",\"url\":\"redacted\",\"pid\":$PID,\"warning\":\"set OBS_AUTH_TOKEN or OBS_ALLOW_UNAUTH_TUNNEL=1 to reveal public URL\"}"
      fi
    else
      echo "{\"status\":\"running\",\"url\":\"unknown\",\"pid\":$PID}"
    fi
  else
    rm -f "$PID_FILE" "$URL_FILE"
    echo '{"status":"not_running"}'
  fi
}

do_url() {
  # Return just the URL with token appended (for the skill)
  require_share_auth || return

  if is_running; then
    URL=$(cat "$URL_FILE" 2>/dev/null || extract_url)
    if [ -n "$URL" ]; then
      # Verify URL is still reachable (Cloudflare may have dropped the connection)
      if ! curl -s --max-time 8 -o /dev/null "${URL}/healthz" 2>/dev/null; then
        # URL dead — kill and restart
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE" "$URL_FILE"
        sleep 1
        do_start >/dev/null 2>&1
        sleep 3
        URL=$(cat "$URL_FILE" 2>/dev/null || extract_url)
      fi
      if [ -n "$URL" ]; then
        echo "{\"status\":\"ok\",$(json_url_field "$URL")}"
        return
      fi
    fi
  fi
  # Not running — start it
  do_start >/dev/null 2>&1
  sleep 3
  # Read fresh URL
  URL=$(cat "$URL_FILE" 2>/dev/null || extract_url)
  if [ -n "$URL" ]; then
    echo "{\"status\":\"ok\",$(json_url_field "$URL")}"
  else
    echo "{\"status\":\"error\",\"error\":\"Failed to start tunnel\"}"
  fi
}

case "${1:-url}" in
  start)  do_start ;;
  stop)   do_stop ;;
  status) do_status ;;
  url)    do_url ;;
  *)      echo "Usage: $0 {start|stop|status|url}"; exit 1 ;;
esac
