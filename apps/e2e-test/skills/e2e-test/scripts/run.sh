#!/usr/bin/env bash
# run.sh — execute a scenario file against the current worktree's stack.
# Usage: run.sh <scenario-name>

set -euo pipefail

SCENARIO="${1:-}"
[[ -z "$SCENARIO" ]] && { echo "Usage: run.sh <scenario-name>" >&2; exit 2; }

# scenario-name must be a single token without slashes or extensions.
if [[ "$SCENARIO" =~ [/.] ]]; then
  echo "ERROR: scenario-name must be a single token without '/' or '.' (got: $SCENARIO)" >&2
  exit 2
fi

WORKTREE_ROOT=$(git rev-parse --show-toplevel)
cd "$WORKTREE_ROOT"

ENV_FILE="$WORKTREE_ROOT/.env.dispatch"
SCENARIO_FILE="$WORKTREE_ROOT/.e2e-scenarios/$SCENARIO.sh"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env.dispatch not found. Run 'dev-up up' first." >&2; exit 1; }
[[ -f "$SCENARIO_FILE" ]] || { echo "ERROR: scenario not found: $SCENARIO_FILE" >&2; exit 1; }
command -v agent-browser >/dev/null 2>&1 || { echo "ERROR: agent-browser not installed. Run 'e2e-test install' first." >&2; exit 1; }

# shellcheck disable=SC1090
source "$ENV_FILE"

export AGENT_BROWSER_SESSION="$PROJECT-$SLOT"
export RESULTS_DIR="$WORKTREE_ROOT/.e2e-results/$SCENARIO"
mkdir -p "$RESULTS_DIR"

echo "running scenario: $SCENARIO (session=$AGENT_BROWSER_SESSION)"
bash "$SCENARIO_FILE"
echo "scenario complete. Results in: $RESULTS_DIR"
