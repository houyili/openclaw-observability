#!/usr/bin/env bash
# Upgrade an existing OpenClaw Observability checkout.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/upgrade.sh [--yes] [--dry-run]

Checks for a clean git checkout, pulls with --ff-only, regenerates the
user-level service file, restarts the service, and checks /healthz.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) OBS_YES=1 ;;
    --dry-run) OBS_DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

section "OpenClaw Observability upgrade"
say "Project: $PROJECT_DIR"
require_node22

if [ ! -d "$PROJECT_DIR/.git" ]; then
  if [ "$OBS_DRY_RUN" = "1" ]; then
    warn "This directory is not a standalone git checkout yet: $PROJECT_DIR"
    warn "Dry-run continues; after release this path should be a nested clone."
  else
    fail "This directory is not a standalone git checkout: $PROJECT_DIR"
  fi
fi

section "Git state"
status=""
if [ -d "$PROJECT_DIR/.git" ]; then
  status="$(git -C "$PROJECT_DIR" status --short)"
fi
if [ -n "$status" ]; then
  say "$status"
  if [ "$OBS_DRY_RUN" = "0" ]; then
    fail "Working tree is not clean. Commit, stash, or discard local changes before upgrade."
  fi
  warn "Dry-run continues despite dirty working tree."
else
  say "Working tree clean."
fi

say "Upgrade will run: git pull --ff-only"
if confirm "Fetch and fast-forward this checkout?" "yes"; then
  if [ -d "$PROJECT_DIR/.git" ]; then
    run_cmd git -C "$PROJECT_DIR" pull --ff-only
  else
    say "DRY-RUN: would run git pull --ff-only in standalone checkout"
  fi
fi

section "Regenerate service"
if is_macos; then
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" generate-plist
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" check
elif is_linux; then
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" generate-systemd
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" check-systemd
fi

if confirm "Restart the user-level service now?" "yes"; then
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" restart
fi

section "Health check"
if [ "$OBS_DRY_RUN" = "1" ]; then
  say "DRY-RUN: would check $DASHBOARD_URL/healthz"
elif curl -s --max-time 5 "$DASHBOARD_URL/healthz" >/dev/null 2>&1; then
  say "Dashboard is responding: $DASHBOARD_URL"
else
  warn "Dashboard is not responding. Run scripts/doctor.sh and scripts/service.sh logs."
fi
