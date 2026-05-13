#!/usr/bin/env bash
# teardown.sh — close the agent-browser session for this worktree.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
[[ -f "$ENV_FILE" ]] || { echo "no .env.dispatch found; nothing to teardown" >&2; exit 0; }

# shellcheck disable=SC1090
source "$ENV_FILE"
SESSION="$PROJECT-$SLOT"

agent-browser --session "$SESSION" close 2>/dev/null || true
echo "agent-browser session closed: $SESSION"
