#!/usr/bin/env bash
# Read-only diagnostics for OpenClaw Observability.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

failures=0
warnings=0

ok() { say "OK: $*"; }
bad() { say "FAIL: $*"; failures=$((failures + 1)); }
soft() { say "WARN: $*"; warnings=$((warnings + 1)); }

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name found at $(command -v "$name")"
  else
    soft "$name not found on PATH"
  fi
}

section "Project"
say "Project: $PROJECT_DIR"
say "OS:      $(uname -s)"
say "Home:    $HOME"

section "Dependencies"
if command -v node >/dev/null 2>&1; then
  major="$(node_major "$(command -v node)")"
  if [ "$major" -ge 22 ]; then
    ok "Node.js $(node -v)"
  else
    bad "Node.js 22+ required, found $(node -v)"
  fi
else
  bad "node not found"
fi
check_cmd git
check_cmd curl
check_cmd openclaw

section "Configuration"
if [ -f "$ENV_FILE" ]; then
  ok ".env exists and is local"
else
  soft ".env missing; run scripts/install.sh"
fi
if git -C "$PROJECT_DIR" ls-files --error-unmatch .env >/dev/null 2>&1; then
  bad ".env is tracked by git"
else
  ok ".env is not tracked by git"
fi
if git -C "$PROJECT_DIR" ls-files '*.plist' '*.db' '*.sqlite' 'logs/*' 2>/dev/null | grep -q .; then
  bad "generated plist/log/db files are tracked by git"
else
  ok "no generated plist/log/db files are tracked"
fi

section "Service"
if is_macos || is_linux; then
  bash "$PROJECT_DIR/scripts/service.sh" status || soft "service status returned nonzero"
else
  soft "service helper does not manage this OS"
fi

section "Port and health"
if curl -s --max-time 5 "$DASHBOARD_URL/healthz" >/dev/null 2>&1; then
  ok "health endpoint responds at $DASHBOARD_URL/healthz"
else
  soft "health endpoint is not responding at $DASHBOARD_URL/healthz"
fi
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:18902 -sTCP:LISTEN || true
fi

section "Summary"
say "Failures: $failures"
say "Warnings:  $warnings"
exit 0
