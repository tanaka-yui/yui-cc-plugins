#!/usr/bin/env bash
# compose-up.sh — bring up an isolated dev stack for this worktree.

set -euo pipefail

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
CONFIG_FILE="$WORKTREE_ROOT/.dev-up.yaml"
ENV_FILE="$WORKTREE_ROOT/.env.dispatch"

[[ -f "$CONFIG_FILE" ]] || { echo "ERROR: .dev-up.yaml not found. Run 'dev-up setup' first." >&2; exit 1; }

# Parse --slot-range.
SLOT_RANGE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot-range) SLOT_RANGE_ARGS=(--slot-range "$2"); shift 2;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2;;
  esac
done

PROJECT=$(yq -r '.project' "$CONFIG_FILE")

# Idempotency: existing .env.dispatch.
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
  alive=false
  if docker compose -p "$COMPOSE_PROJECT_NAME" ps -q 2>/dev/null | grep -q .; then alive=true; fi
  if [[ -f "$SLOT_DIR/processes.json" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "null" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then alive=true; break; fi
    done < <(jq -r '.[].pid' "$SLOT_DIR/processes.json" 2>/dev/null)
  fi
  if $alive; then
    echo "Already up on slot=$SLOT. Re-printing URLs."
    bash "$LIB_DIR/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
    exit 0
  else
    echo "Stale .env.dispatch found (no live processes). Re-reserving." >&2
    rm -f "$ENV_FILE"
  fi
fi

# Reserve slot.
SLOT=$(bash "$SCRIPT_DIR/reserve-slot.sh" "$PROJECT" "${SLOT_RANGE_ARGS[@]+"${SLOT_RANGE_ARGS[@]}"}")
echo "reserved slot=$SLOT"
SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
PROCESSES_JSON="$SLOT_DIR/processes.json"

# Generate .env.dispatch.
bash "$LIB_DIR/render-env.sh" "$CONFIG_FILE" "$SLOT" "$ENV_FILE"

# Topological sort.
SORTED=$(bash "$LIB_DIR/topo-sort.sh" "$CONFIG_FILE")

# Start each service in order.
while IFS= read -r SVC; do
  [[ -z "$SVC" ]] && continue
  SVC_INDEX=$(yq -r ".services | to_entries | map(select(.value.name == \"$SVC\")) | .[0].key" "$CONFIG_FILE")
  TYPE=$(yq -r ".services[$SVC_INDEX].type" "$CONFIG_FILE")

  echo "starting $SVC (type=$TYPE)"

  case "$TYPE" in
    docker-compose)
      COMPOSE_FILES=()
      while IFS= read -r f; do COMPOSE_FILES+=("$f"); done < <(yq -r ".services[$SVC_INDEX].files[]" "$CONFIG_FILE")
      COMPOSE_F_ARGS=()
      for f in "${COMPOSE_FILES[@]}"; do COMPOSE_F_ARGS+=(-f "$f"); done
      docker compose "${COMPOSE_F_ARGS[@]}" --env-file "$ENV_FILE" -p "$PROJECT-$SLOT" up -d --wait
      ;;
    command)
      bash "$LIB_DIR/spawn-command.sh" "$CONFIG_FILE" "$SVC" "$ENV_FILE" "$PROCESSES_JSON"

      # Health check, if defined.
      HC_KIND=$(yq -r ".services[$SVC_INDEX].health_check.kind // \"\"" "$CONFIG_FILE")
      if [[ -n "$HC_KIND" ]]; then
        HC_TARGET=$(yq -r ".services[$SVC_INDEX].health_check.target" "$CONFIG_FILE")
        HC_TIMEOUT=$(yq -r ".services[$SVC_INDEX].health_check.timeout // 60" "$CONFIG_FILE")
        HC_INTERVAL=$(yq -r ".services[$SVC_INDEX].health_check.interval // 1" "$CONFIG_FILE")
        # Expand ${VAR} from .env.dispatch.
        # shellcheck disable=SC1090
        ( source "$ENV_FILE"; bash "$LIB_DIR/wait-health.sh" "$HC_KIND" "$(eval "echo \"$HC_TARGET\"")" "$HC_TIMEOUT" "$HC_INTERVAL" )
      fi
      ;;
    *)
      echo "ERROR: unknown service type: $TYPE" >&2
      exit 1
      ;;
  esac
done <<< "$SORTED"

# Smoke test.
bash "$LIB_DIR/smoke.sh" "$CONFIG_FILE" "$ENV_FILE"

# URL table.
bash "$LIB_DIR/render-urls.sh" "$CONFIG_FILE" "$ENV_FILE"
