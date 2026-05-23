#!/usr/bin/env bash
# Interactive uninstaller for OpenClaw Observability.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

PURGE_DATA=0
REMOVE_ENV=0
REMOVE_REPO=0

usage() {
  cat <<'USAGE'
Usage: scripts/uninstall.sh [--yes] [--dry-run] [--purge-data] [--remove-env] [--remove-repo]

By default this removes only the user-level service. Local .env, logs,
SQLite data, and the git checkout are preserved unless explicitly confirmed.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) OBS_YES=1 ;;
    --dry-run) OBS_DRY_RUN=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --remove-env) REMOVE_ENV=1 ;;
    --remove-repo) REMOVE_REPO=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

section "OpenClaw Observability uninstall"
say "Project: $PROJECT_DIR"
say "Default: remove service only; preserve config, logs, DB, and repo."

if confirm "Uninstall the user-level service?" "yes"; then
  run_cmd bash "$PROJECT_DIR/scripts/service.sh" uninstall
fi

if [ "$REMOVE_ENV" = "1" ] || confirm "Remove local .env config?" "no"; then
  run_cmd rm -f "$ENV_FILE"
fi

if [ "$PURGE_DATA" = "1" ] || confirm "Remove logs and SQLite DB at $LOG_DIR?" "no"; then
  say "This deletes local observability cache only; source transcripts are not stored here."
  run_cmd rm -rf "$LOG_DIR"
fi

if [ "$REMOVE_REPO" = "1" ] || confirm "Remove this git checkout too?" "no"; then
  say "This will delete: $PROJECT_DIR"
  if [ "$OBS_YES" = "1" ] || confirm "Type yes by answering this prompt to delete the checkout." "no"; then
    if [ "$OBS_DRY_RUN" = "1" ]; then
      say "DRY-RUN: rm -rf $PROJECT_DIR"
    else
      parent_dir="$(dirname "$PROJECT_DIR")"
      repo_base="$(basename "$PROJECT_DIR")"
      cd "$parent_dir"
      rm -rf "$repo_base"
    fi
  fi
fi

section "Done"
