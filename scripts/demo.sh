#!/usr/bin/env bash
# OpenClaw Observability demo mode.
#
# Seeds a synthetic OPENCLAW_HOME under /tmp/obs-v2-demo-home (override
# with --target) and launches the dashboard against it. Lets a user
# without an OpenClaw install see what obs-v2 looks like.
#
# Usage:
#   scripts/demo.sh [--target /path] [--port 18902] [--force] [--seed-only]
#
#   --target     where to put the synthetic OPENCLAW_HOME
#                (default /tmp/obs-v2-demo-home)
#   --port       HTTP port for the dashboard (default 18902)
#   --force      overwrite an already-populated target
#   --seed-only  seed the target and print the start command, do not
#                launch the dashboard
#   --help       this message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="/tmp/obs-v2-demo-home"
PORT="18902"
FORCE=""
SEED_ONLY=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)    TARGET="${2:-}"; shift 2 ;;
    --target=*)  TARGET="${1#--target=}"; shift ;;
    --port)      PORT="${2:-}"; shift 2 ;;
    --port=*)    PORT="${1#--port=}"; shift ;;
    --force)     FORCE="--force"; shift ;;
    --seed-only) SEED_ONLY="1"; shift ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node is not on PATH. Install Node.js 22+ first." >&2
  exit 1
fi

echo "[demo] seeding OPENCLAW_HOME at $TARGET"
"$NODE_BIN" --experimental-sqlite --experimental-strip-types --no-warnings \
  "$PROJECT_DIR/scripts/seed-demo-home.ts" \
  --target="$TARGET" $FORCE

if [ "$SEED_ONLY" = "1" ]; then
  echo "[demo] seed-only mode; not starting the dashboard."
  echo "[demo] start it later with:"
  echo "[demo]   OPENCLAW_HOME=$TARGET npm run start"
  exit 0
fi

echo "[demo] starting dashboard against the demo home"
echo "[demo] (no real OpenClaw data is touched; CTRL+C to stop)"
echo "[demo] dashboard: http://127.0.0.1:$PORT"

cd "$PROJECT_DIR"
export OPENCLAW_HOME="$TARGET"
export OBS_PORT="$PORT"
# OBS_AUTH_TOKEN is read from .env if present; the demo intentionally
# leaves it empty so the user can open the dashboard without a token.
export OBS_AUTH_TOKEN=""
exec "$NODE_BIN" --experimental-sqlite --experimental-strip-types --no-warnings \
  src/index.ts
