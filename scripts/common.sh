#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_URL="${OBS_DASHBOARD_URL:-http://127.0.0.1:18902}"
LOG_DIR="${OPENCLAW_HOME:-$HOME/.openclaw}/logs/observability-v2"
ENV_FILE="$PROJECT_DIR/.env"
OBS_YES="${OBS_YES:-0}"
OBS_DRY_RUN="${OBS_DRY_RUN:-0}"

say() {
  printf '%s\n' "$*"
}

section() {
  printf '\n== %s ==\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

is_linux() {
  [ "$(uname -s)" = "Linux" ]
}

confirm() {
  local prompt="$1"
  local default="${2:-yes}"
  local suffix="[Y/n]"
  [ "$default" = "no" ] && suffix="[y/N]"

  if [ "$OBS_YES" = "1" ]; then
    say "$prompt $suffix $default"
    [ "$default" = "yes" ]
    return $?
  fi
  if [ ! -t 0 ]; then
    [ "$default" = "yes" ]
    return $?
  fi

  local answer
  read -r -p "$prompt $suffix " answer
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

run_cmd() {
  if [ "$OBS_DRY_RUN" = "1" ]; then
    say "DRY-RUN: $*"
  else
    "$@"
  fi
}

node_major() {
  local node_bin="$1"
  "$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0'
}

require_node22() {
  local node_bin="${NODE_BIN:-$(command -v node || true)}"
  [ -n "$node_bin" ] || fail "Node.js is not on PATH. Install Node.js 22 or newer, then rerun this script."
  local major
  major="$(node_major "$node_bin")"
  [ "$major" -ge 22 ] || fail "Node.js 22+ is required. Found $("$node_bin" -v 2>/dev/null || echo unknown) at $node_bin."
  say "Node.js OK: $("$node_bin" -v) ($node_bin)"
}

check_openclaw_cli() {
  if command -v openclaw >/dev/null 2>&1; then
    say "OpenClaw CLI OK: $(command -v openclaw)"
    return 0
  fi
  warn "OpenClaw CLI was not found on PATH."
  warn "The dashboard can start, but live session inventory requires 'openclaw sessions --json'."
  confirm "Continue without OpenClaw CLI for now?" "yes"
}

write_env_if_missing() {
  if [ -f "$ENV_FILE" ]; then
    say ".env already exists; leaving it unchanged."
    return 0
  fi
  say "This will create $ENV_FILE from .env.example."
  say "It may later contain OBS_AUTH_TOKEN or tunnel URL settings, so it is git-ignored."
  if confirm "Create .env now?" "yes"; then
    run_cmd cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  fi
}

append_env_value() {
  local key="$1"
  local value="$2"
  [ -n "$value" ] || return 0
  if [ "$OBS_DRY_RUN" = "1" ]; then
    say "DRY-RUN: set $key in $ENV_FILE"
    return 0
  fi
  touch "$ENV_FILE"
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE"; then
    tmp_file="${ENV_FILE}.tmp"
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      $0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "[[:space:]]*=" {
        print k "=" v; done = 1; next
      }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" > "$tmp_file"
    mv "$tmp_file" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}
