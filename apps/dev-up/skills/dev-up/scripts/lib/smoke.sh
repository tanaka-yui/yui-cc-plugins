#!/usr/bin/env bash
# smoke.sh — run smoke[] from .dev-up.yaml. WARN-only, never exits non-zero.
# Usage: smoke.sh <config-file> <env-dispatch-file>

set -uo pipefail

CONFIG_FILE="$1"
ENV_FILE="$2"

# shellcheck disable=SC1090
source "$ENV_FILE"

warn() { echo "WARN: smoke - $*" >&2; }

run_smoke() {
  local kind="$1"; local target="$2"; local user="$3"
  # Expand ${VAR} from the sourced env.
  target=$(eval "echo \"$target\"")
  case "$kind" in
    http)
      curl -fsS --max-time 5 "$target" -o /dev/null 2>/dev/null \
        || warn "http $target failed"
      ;;
    pg)
      local host="${target%%:*}"
      local port="${target##*:}"
      pg_isready -h "$host" -p "$port" -U "${user:-postgres}" -t 5 > /dev/null 2>&1 \
        || warn "pg $target user=$user failed"
      ;;
    redis)
      local host="${target%%:*}"
      local port="${target##*:}"
      redis-cli -h "$host" -p "$port" ping > /dev/null 2>&1 \
        || warn "redis $target failed"
      ;;
    *)
      warn "unknown kind: $kind (skipping)"
      ;;
  esac
}

# Iterate smoke[] using yq.
count=$(yq -r '.smoke | length // 0' "$CONFIG_FILE")
for i in $(seq 0 $((count - 1))); do
  [[ "$count" == "0" ]] && break
  kind=$(yq -r ".smoke[$i].kind" "$CONFIG_FILE")
  target=$(yq -r ".smoke[$i].target" "$CONFIG_FILE")
  user=$(yq -r ".smoke[$i].user // \"\"" "$CONFIG_FILE")
  run_smoke "$kind" "$target" "$user"
done

exit 0
