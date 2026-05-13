#!/usr/bin/env bash
# reserve-slot.sh — reserve a free port slot for this worktree.
# Usage: reserve-slot.sh <project> [--slot-range MIN-MAX]
# stdout: reserved slot number.

set -euo pipefail

PROJECT="${1:-}"
[[ -z "$PROJECT" ]] && { echo "Usage: reserve-slot.sh <project> [--slot-range MIN-MAX]" >&2; exit 2; }
shift

# Defaults (overridden by --slot-range).
SLOT_MIN=1
SLOT_MAX=9

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot-range)
      [[ "$2" =~ ^([0-9]+)-([0-9]+)$ ]] || { echo "ERROR: --slot-range must be MIN-MAX" >&2; exit 2; }
      SLOT_MIN="${BASH_REMATCH[1]}"
      SLOT_MAX="${BASH_REMATCH[2]}"
      shift 2
      ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2;;
  esac
done

REGISTRY="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots"
mkdir -p "$REGISTRY"

# Phase 1: zombie sweep.
for slot_dir in "$REGISTRY"/*/; do
  [[ -d "$slot_dir" ]] || continue
  slot=$(basename "$slot_dir")

  # Skip dirs without owner.json (e.g. mid-write); they block Phase 2 by design.
  [[ -f "$slot_dir/owner.json" ]] || continue

  owner_wt=$(jq -r '.worktree // empty' "$slot_dir/owner.json" 2>/dev/null || echo "")
  cp_name=$(jq -r '.compose_project // empty' "$slot_dir/owner.json" 2>/dev/null || echo "")

  # Worktree gone?
  if [[ -z "$owner_wt" || ! -d "$owner_wt" ]]; then
    rm -rf "$slot_dir"; continue
  fi

  # compose project has no containers?
  compose_alive=false
  if [[ -n "$cp_name" ]] && docker compose -p "$cp_name" ps -q 2>/dev/null | grep -q .; then
    compose_alive=true
  fi

  # Any spawned PID still alive?
  processes_alive=false
  if [[ -f "$slot_dir/processes.json" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" || "$pid" == "null" ]] && continue
      if kill -0 "$pid" 2>/dev/null; then processes_alive=true; break; fi
    done < <(jq -r '.[].pid' "$slot_dir/processes.json" 2>/dev/null)
  fi

  # Count pid entries; a freshly reserved slot (no entries yet) is not a zombie.
  pid_count=$(jq -r '.[].pid' "$slot_dir/processes.json" 2>/dev/null | grep -cv '^$' || true)

  if ! $compose_alive && ! $processes_alive && [[ "$pid_count" -gt 0 ]]; then
    rm -rf "$slot_dir"
  fi
done

# Phase 2: atomic mkdir reservation.
for slot in $(seq "$SLOT_MIN" "$SLOT_MAX"); do
  slot_dir="$REGISTRY/$slot"
  if mkdir "$slot_dir" 2>/dev/null; then
    worktree=$(git rev-parse --show-toplevel)
    cat > "$slot_dir/owner.json" <<EOF
{
  "pid": $$,
  "worktree": "$worktree",
  "compose_project": "$PROJECT-$slot",
  "reserved_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    echo '{}' > "$slot_dir/processes.json"
    echo "$slot"
    exit 0
  fi
done

echo "ERROR: no free slot in [$SLOT_MIN, $SLOT_MAX]. Run 'dev-up down' in an unused worktree or extend --slot-range." >&2
exit 1
