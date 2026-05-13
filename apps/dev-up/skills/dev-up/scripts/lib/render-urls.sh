#!/usr/bin/env bash
# render-urls.sh — print URL table for current slot.
# Usage: render-urls.sh <config-file> <env-dispatch-file>

set -euo pipefail

CONFIG_FILE="$1"
ENV_FILE="$2"

# shellcheck disable=SC1090
source "$ENV_FILE"

cat <<HDR
┌────────────────────────────────────────────────────────────┐
│ $PROJECT (slot=$SLOT) services are up
├────────────────────────────────────────────────────────────┤
HDR

yq -r '.urls[] | "\(.label)\t\(.template)"' "$CONFIG_FILE" \
  | while IFS=$'\t' read -r label template; do
      # Expand ${VAR} from the sourced env.
      expanded=$(eval "echo \"$template\"")
      printf "│ %-12s %s\n" "$label:" "$expanded"
    done

cat <<FTR
└────────────────────────────────────────────────────────────┘
FTR
