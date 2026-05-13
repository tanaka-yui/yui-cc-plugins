#!/usr/bin/env bash
# snapshot.sh — take a snapshot of the current page (or an optionally provided URL).
# Usage: snapshot.sh [url]

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found." >&2; exit 1; }

# shellcheck disable=SC1090
source "$ENV_FILE"
SESSION="$PROJECT-$SLOT"

URL="${1:-}"
if [[ -n "$URL" ]]; then
  agent-browser --session "$SESSION" open "$URL"
fi

agent-browser --session "$SESSION" snapshot --json
