#!/bin/sh

obs_project_dir() {
  cd "$(dirname "$0")/.." && pwd
}

obs_env_file() {
  printf '%s/.env' "$(obs_project_dir)"
}

obs_trim() {
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

obs_read_env_value() {
  key="$1"
  file="${2:-$(obs_env_file)}"
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -1 || true)
  [ -n "$line" ] || return 0
  value=${line#*=}
  value=$(printf '%s' "$value" | obs_trim)
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}
