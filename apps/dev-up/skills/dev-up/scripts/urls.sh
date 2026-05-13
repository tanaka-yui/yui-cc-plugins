#!/usr/bin/env bash
# urls.sh — print service URL table.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found. Run 'dev-up up' first." >&2; exit 1; }

bash "$SCRIPT_DIR/lib/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
