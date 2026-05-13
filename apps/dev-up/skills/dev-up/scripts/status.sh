#!/usr/bin/env bash
# status.sh — show slot, running services (docker + command), and URLs.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "no slot reserved for this worktree (.env.dispatch not found)"
  exit 0
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
echo "slot: $SLOT"
echo "compose project: $COMPOSE_PROJECT_NAME"
echo ""

# docker-compose services.
if yq -e '.services[] | select(.type == "docker-compose")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "docker containers:"
  docker compose -p "$COMPOSE_PROJECT_NAME" ps 2>/dev/null || echo "  (none)"
  echo ""
fi

# command services.
PROCESSES_JSON="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT/processes.json"
if [[ -f "$PROCESSES_JSON" ]]; then
  echo "command services:"
  jq -r 'to_entries[] | "  \(.key)\tpid=\(.value.pid)\tlog=\(.value.log_file)"' "$PROCESSES_JSON" \
    | while IFS=$'\t' read -r name_part pid_part log_part; do
        pid="${pid_part#pid=}"
        if kill -0 "$pid" 2>/dev/null; then alive="alive"; else alive="DEAD"; fi
        echo "$name_part  [$alive]  $pid_part  $log_part"
      done
  echo ""
fi

bash "$SCRIPT_DIR/lib/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
