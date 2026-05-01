#!/bin/bash
# Launch multiple Claude Code sessions in cmux split panes for parallel execution.
# Convenience wrapper around launch-workspace.sh for the superpowers integration path.
#
# Usage:
#   launch-session-splits.sh [options]
#
# Options:
#   --mode plan|superpowers         Claude launch mode (default: superpowers)
#   --tasks <json-string>           Tasks as inline JSON array
#   --tasks-file <path>             Tasks as JSON file path
#   --wait                          Wait for all tasks to complete before exiting
#   --wait-timeout <seconds>        Timeout per task for --wait (default: 1800)
#   --no-grid                       Skip grid layout reorganization after launch
#   --help                          Show this help message
#
# Tasks JSON format:
#   [
#     {"slug": "task-name", "prompt": "Full task description...", "runner": "claude"},
#     {"slug": "other-task", "prompt": "Another task...", "runner": "ccenec"},
#     ...
#   ]
#
# Each task object:
#   - slug (required):   Short identifier (lowercase, hyphens, max 30 chars)
#   - prompt (required): Full prompt text for the child Claude session
#   - runner (optional): Runner name registered in
#                        ~/.claude/cmux-team-dispatch-task/runners.json. Controls
#                        which runtime the child session uses (claude / codex /
#                        zsh function). Omit to use the script default
#                        (hardcoded claude).
#
# Output: JSON to stdout with parent/task details
# Debug:  Logs to stderr

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_SCRIPT="$SCRIPT_DIR/launch-workspace.sh"
CMUX="/Applications/cmux.app/Contents/Resources/bin/cmux"

# --- Helpers ---

die() {
  echo "Error: $1" >&2
  exit 1
}

log() {
  echo "[$1] $2" >&2
}

show_help() {
  sed -n '2,/^$/{ s/^# //; s/^#//; p; }' "$0"
  exit 0
}

# --- Argument Parsing ---

MODE="superpowers"
TASKS_JSON=""
TASKS_FILE=""
WAIT=false
WAIT_TIMEOUT=1800
GRID=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      show_help
      ;;
    --mode)
      [[ $# -lt 2 ]] && die "--mode requires plan or superpowers"
      MODE="$2"
      [[ "$MODE" == "plan" || "$MODE" == "superpowers" ]] || die "--mode must be 'plan' or 'superpowers'"
      shift 2
      ;;
    --tasks)
      [[ $# -lt 2 ]] && die "--tasks requires a JSON string"
      TASKS_JSON="$2"
      shift 2
      ;;
    --tasks-file)
      [[ $# -lt 2 ]] && die "--tasks-file requires a file path"
      TASKS_FILE="$2"
      shift 2
      ;;
    --wait)
      WAIT=true
      shift
      ;;
    --wait-timeout)
      [[ $# -lt 2 ]] && die "--wait-timeout requires a number"
      WAIT_TIMEOUT="$2"
      shift 2
      ;;
    --no-grid)
      GRID=false
      shift
      ;;
    *)
      die "unknown option: $1. Use --help for usage."
      ;;
  esac
done

# --- Validation ---

[[ -x "$CMUX" ]] || die "cmux is not installed at $CMUX"
[[ -x "$LAUNCH_SCRIPT" ]] || [[ -f "$LAUNCH_SCRIPT" ]] || die "launch-workspace.sh not found at $LAUNCH_SCRIPT"
command -v jq &>/dev/null || die "jq is not installed (required for JSON processing)"

# Load tasks JSON
if [[ -n "$TASKS_FILE" ]]; then
  [[ -f "$TASKS_FILE" ]] || die "tasks file not found: $TASKS_FILE"
  TASKS_JSON=$(cat "$TASKS_FILE")
elif [[ -z "$TASKS_JSON" ]]; then
  die "either --tasks or --tasks-file is required"
fi

# Validate JSON is an array
TASK_COUNT=$(echo "$TASKS_JSON" | jq 'length' 2>/dev/null) || die "invalid tasks JSON"
[[ "$TASK_COUNT" -gt 0 ]] || die "tasks array is empty"
log "tasks" "loaded $TASK_COUNT tasks"

# --- Detect Parent Workspace/Surface ---

log "cmux" "identifying current workspace and surface"
IDENTIFY_OUTPUT=$("$CMUX" identify 2>/dev/null) || die "cmux identify failed. Are you inside a cmux session?"

PARENT_WS=$(echo "$IDENTIFY_OUTPUT" | grep -oE 'workspace:[0-9]+' | head -1)
PARENT_SF=$(echo "$IDENTIFY_OUTPUT" | grep -oE 'surface:[0-9]+' | head -1)

[[ -n "$PARENT_WS" ]] || die "could not detect parent workspace ID"
[[ -n "$PARENT_SF" ]] || die "could not detect parent surface ID"

# Use environment variables if set (override detection)
PARENT_WS="${CMUX_WORKSPACE_ID:-$PARENT_WS}"
PARENT_SF="${CMUX_SURFACE_ID:-$PARENT_SF}"

log "cmux" "parent workspace: $PARENT_WS, surface: $PARENT_SF"

# --- Resolve Project Root ---

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"

# --- Launch Tasks ---

RESULTS="[]"
PREV_SURFACE="$PARENT_SF"
SIGNAL_NAMES=()

for i in $(seq 0 $((TASK_COUNT - 1))); do
  SLUG=$(echo "$TASKS_JSON" | jq -r ".[$i].slug")
  PROMPT=$(echo "$TASKS_JSON" | jq -r ".[$i].prompt")
  RUNNER=$(echo "$TASKS_JSON" | jq -r ".[$i].runner // \"\"")
  [[ -n "$SLUG" && "$SLUG" != "null" ]] || die "task $i is missing 'slug' field"
  [[ -n "$PROMPT" && "$PROMPT" != "null" ]] || die "task $i ($SLUG) is missing 'prompt' field"

  # Determine split direction
  if [[ $i -eq 0 ]]; then
    SPLIT_DIR="right"
    SPLIT_FROM="$PARENT_SF"
  else
    SPLIT_DIR="down"
    SPLIT_FROM="$PREV_SURFACE"
  fi

  STATUS_DIR="$PROJECT_ROOT/.dispatch/$SLUG"
  mkdir -p "$STATUS_DIR"

  log "launch" "task $((i+1))/$TASK_COUNT: $SLUG (split $SPLIT_DIR from $SPLIT_FROM, runner=${RUNNER:-<default>})"

  # Build launch-workspace.sh arguments
  LAUNCH_ARGS=(
    --mode "$MODE"
    --layout split
    --parent-workspace "$PARENT_WS"
    --split-from "$SPLIT_FROM"
    --split-direction "$SPLIT_DIR"
    --status-dir "$STATUS_DIR"
    --parent-notify-workspace "$PARENT_WS"
    --parent-notify-surface "$PARENT_SF"
  )

  # Pass per-task runner override if specified
  if [[ -n "$RUNNER" ]]; then
    LAUNCH_ARGS+=(--runner "$RUNNER")
  fi

  LAUNCH_ARGS+=("$SLUG" "$PROMPT")

  # Launch
  RESULT=$(bash "$LAUNCH_SCRIPT" "${LAUNCH_ARGS[@]}") || die "failed to launch task: $SLUG"

  # Extract surface ID for chaining
  TASK_SURFACE=$(echo "$RESULT" | jq -r '.surface_id')
  TASK_SIGNAL=$(echo "$RESULT" | jq -r '.signal_name')

  [[ -n "$TASK_SURFACE" && "$TASK_SURFACE" != "null" ]] || die "failed to get surface ID for task: $SLUG"

  PREV_SURFACE="$TASK_SURFACE"
  SIGNAL_NAMES+=("$TASK_SIGNAL")

  # Accumulate results
  RESULTS=$(echo "$RESULTS" | jq --argjson task "$RESULT" '. + [$task]')

  log "launch" "  -> surface: $TASK_SURFACE, signal: $TASK_SIGNAL"
done

# --- Output JSON ---

OUTPUT=$(jq -n \
  --arg parent_workspace "$PARENT_WS" \
  --arg parent_surface "$PARENT_SF" \
  --argjson tasks "$RESULTS" \
  --argjson grid_layout "$GRID_APPLIED" \
  '{
    parent_workspace: $parent_workspace,
    parent_surface: $parent_surface,
    task_count: ($tasks | length),
    grid_layout: $grid_layout,
    tasks: $tasks
  }')

echo "$OUTPUT"

log "done" "all $TASK_COUNT tasks launched in split panes"

# --- Grid Layout Reorganization ---

GRID_APPLIED=false

if [[ "$GRID" == true && "$TASK_COUNT" -ge 2 ]]; then
  GRID_SCRIPT="$SCRIPT_DIR/cmux-grid.sh"
  if [[ -f "$GRID_SCRIPT" ]]; then
    log "grid" "reorganizing $((TASK_COUNT + 1)) surfaces into grid layout"
    # 起動直後のペイン描画を待つ
    sleep 0.5
    if bash "$GRID_SCRIPT" --workspace "$PARENT_WS" 2>&1 | while IFS= read -r line; do log "grid" "$line"; done; then
      GRID_APPLIED=true
      log "grid" "grid layout applied"
    else
      log "grid" "warning: grid layout failed (non-fatal, panes remain in linear layout)"
    fi
  else
    log "grid" "warning: cmux-grid.sh not found at $GRID_SCRIPT, skipping grid layout"
  fi
fi

# --- Optional: Wait for Completion ---

if [[ "$WAIT" == true ]]; then
  log "wait" "waiting for all tasks to complete (timeout: ${WAIT_TIMEOUT}s per task)"

  FAILED=()
  for i in "${!SIGNAL_NAMES[@]}"; do
    SIGNAL="${SIGNAL_NAMES[$i]}"
    SLUG=$(echo "$TASKS_JSON" | jq -r ".[$i].slug")
    log "wait" "waiting for $SLUG ($SIGNAL)..."

    if "$CMUX" wait-for "$SIGNAL" --timeout "$WAIT_TIMEOUT" 2>/dev/null; then
      # Check status.json for actual outcome
      STATUS_FILE="$PROJECT_ROOT/.dispatch/$SLUG/status.json"
      if [[ -f "$STATUS_FILE" ]]; then
        STATUS=$(jq -r '.status' "$STATUS_FILE" 2>/dev/null || echo "unknown")
        MESSAGE=$(jq -r '.message' "$STATUS_FILE" 2>/dev/null || echo "")
        log "wait" "  $SLUG: $STATUS - $MESSAGE"
        if [[ "$STATUS" == "error" ]]; then
          FAILED+=("$SLUG")
        fi
      fi
    else
      log "wait" "  $SLUG: timed out after ${WAIT_TIMEOUT}s"
      FAILED+=("$SLUG")
    fi
  done

  if [[ ${#FAILED[@]} -gt 0 ]]; then
    log "wait" "tasks with issues: ${FAILED[*]}"
    exit 1
  else
    log "wait" "all tasks completed successfully"
  fi
fi
