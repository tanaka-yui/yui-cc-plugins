#!/usr/bin/env bash
# compose-down.sh — stop all services and release the slot.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "no .env.dispatch found; nothing to bring down" >&2
  exit 0
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
PROCESSES_JSON="$SLOT_DIR/processes.json"

# Topological sort then reverse for shutdown order.
# awk reverse works on both macOS (no tac) and Linux (no tail -r).
SORTED=$(bash "$LIB_DIR/topo-sort.sh" "$CONFIG_FILE" | awk '{a[NR]=$0} END{for(i=NR;i>0;i--) print a[i]}')

# Stop command services first (reverse order).
while IFS= read -r SVC; do
  [[ -z "$SVC" ]] && continue
  SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC\")) | .[0].key" "$CONFIG_FILE")
  TYPE=$(yq -r ".services[$SVC_INDEX].type" "$CONFIG_FILE")
  [[ "$TYPE" != "command" ]] && continue

  if [[ -f "$PROCESSES_JSON" ]]; then
    PGID=$(jq -r ".\"$SVC\".pgid // empty" "$PROCESSES_JSON")
    if [[ -n "$PGID" && "$PGID" != "null" ]]; then
      echo "stopping command service: $SVC (pgid=$PGID)"
      bash "$LIB_DIR/kill-pgid.sh" "$PGID" || true
    fi
  fi
done <<< "$SORTED"

# Stop docker-compose services. compose down is project-scoped so a single call covers all of them.
if yq -e '.services[] | select(.type == "docker-compose")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "stopping docker compose project: $COMPOSE_PROJECT_NAME"
  # Collect -f files across docker-compose services.
  COMPOSE_F_ARGS=()
  while IFS= read -r f; do COMPOSE_F_ARGS+=(-f "$f"); done < <(yq -r '.services[] | select(.type == "docker-compose") | .files[]' "$CONFIG_FILE" | sort -u)
  docker compose "${COMPOSE_F_ARGS[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" down || true
fi

# Release slot (which also wipes processes.json).
bash "$SCRIPT_DIR/release-slot.sh" "$PROJECT" "$SLOT"

# Remove .env.dispatch.
rm -f "$ENV_FILE"
echo "removed $ENV_FILE"
