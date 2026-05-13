#!/usr/bin/env bash
# render-env.sh — generate .env.dispatch from .dev-up.yaml + slot number.
# Usage: render-env.sh <config-file> <slot> <output-file>

set -euo pipefail

CONFIG_FILE="$1"
SLOT="$2"
OUT_FILE="$3"

PROJECT=$(yq -r '.project' "$CONFIG_FILE")
OFFSET=$(yq -r '.offset_per_slot' "$CONFIG_FILE")
WORKTREE_ROOT=$(git rev-parse --show-toplevel)

{
  echo "COMPOSE_PROJECT_NAME=$PROJECT-$SLOT"
  echo "SLOT=$SLOT"
  echo "PROJECT=$PROJECT"
  echo "WORKTREE_ROOT=$WORKTREE_ROOT"

  # All ports across services.
  yq -r '.services[] | select(.type == "docker-compose") | .ports[] | "\(.name)=\(.base)"' "$CONFIG_FILE" 2>/dev/null \
    | while IFS='=' read -r name base; do
        [[ -z "$name" ]] && continue
        echo "$name=$((base + OFFSET * SLOT))"
      done

  yq -r '.services[] | select(.type == "command") | .env_overrides[]? | "\(.name)=\(.base)"' "$CONFIG_FILE" 2>/dev/null \
    | while IFS='=' read -r name base; do
        [[ -z "$name" ]] && continue
        echo "$name=$((base + OFFSET * SLOT))"
      done
} > "$OUT_FILE"

echo "wrote $OUT_FILE" >&2
