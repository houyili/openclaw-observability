#!/usr/bin/env bash
# Interactive installer for OpenClaw Observability.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

NO_START=0

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [--yes] [--dry-run] [--no-start]

Checks dependencies, creates local config, installs a user-level service,
and verifies the local dashboard health endpoint.

Options:
  -y, --yes      accept recommended prompts
      --dry-run  print actions without writing files or starting services
      --no-start install config/service files but do not start the service
  -h, --help     show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) OBS_YES=1 ;;
    --dry-run) OBS_DRY_RUN=1 ;;
    --no-start) NO_START=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

section "OpenClaw Observability installer"
say "Project:   $PROJECT_DIR"
say "Dashboard: $DASHBOARD_URL"
say "Mode:      $([ "$OBS_DRY_RUN" = "1" ] && echo dry-run || echo live)"

section "Dependency checks"
require_node22
check_openclaw_cli || true
command -v curl >/dev/null 2>&1 || fail "curl is required for health checks."
command -v git >/dev/null 2>&1 || warn "git was not found; upgrade checks will be limited."

section "Local configuration"
write_env_if_missing
if [ "$OBS_YES" = "0" ] && [ -t 0 ]; then
  if confirm "Set OBS_AUTH_TOKEN now for non-local/tunnel access?" "no"; then
    read -r -s -p "OBS_AUTH_TOKEN: " token
    printf '\n'
    append_env_value "OBS_AUTH_TOKEN" "$token"
  fi
else
  say "Skipping OBS_AUTH_TOKEN prompt in non-interactive/--yes mode."
fi

section "Service installation"
if is_macos; then
  say "macOS service path: $HOME/Library/LaunchAgents/com.openclaw.observability-v2.plist"
  say "Permission note: this writes only to your user LaunchAgents directory and log directory."
  if confirm "Install the launchd user service?" "yes"; then
    if [ "$NO_START" = "1" ]; then
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" generate-plist
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" check
    else
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" install
    fi
  fi
elif is_linux; then
  say "Linux service path: $HOME/.config/systemd/user/openclaw-observability.service"
  say "Permission note: this writes only to your user systemd directory and uses systemctl --user."
  if confirm "Install the systemd user service?" "yes"; then
    if [ "$NO_START" = "1" ]; then
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" generate-systemd
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" check-systemd
    else
      run_cmd bash "$PROJECT_DIR/scripts/service.sh" install
    fi
  fi
else
  warn "Unsupported OS for service install: $(uname -s)"
  warn "Use foreground mode: npm run start"
fi

section "Health check"
if [ "$NO_START" = "1" ]; then
  say "Start skipped by --no-start."
elif [ "$OBS_DRY_RUN" = "1" ]; then
  say "DRY-RUN: would check $DASHBOARD_URL/healthz"
elif curl -s --max-time 5 "$DASHBOARD_URL/healthz" >/dev/null 2>&1; then
  say "Dashboard is responding: $DASHBOARD_URL"
else
  warn "Dashboard is not responding yet."
  warn "Check logs with: scripts/service.sh logs"
fi

section "Done"
say "Useful next commands:"
say "  scripts/doctor.sh"
say "  scripts/service.sh status"
say "  scripts/uninstall.sh"
