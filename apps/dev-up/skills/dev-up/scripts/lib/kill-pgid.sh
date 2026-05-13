#!/usr/bin/env bash
# kill-pgid.sh — graceful kill of a process group: SIGTERM, wait 5s, SIGKILL.
# Usage: kill-pgid.sh <pgid>

set -euo pipefail

PGID="${1:-}"
[[ -z "$PGID" ]] && { echo "Usage: kill-pgid.sh <pgid>" >&2; exit 2; }

# Validate it's a positive integer.
[[ "$PGID" =~ ^[0-9]+$ ]] || { echo "ERROR: invalid pgid: $PGID" >&2; exit 2; }

# Check if the process group has any live members.
if ! kill -0 "-$PGID" 2>/dev/null; then
  echo "pgid $PGID has no live processes (already gone)"
  exit 0
fi

echo "sending SIGTERM to pgid $PGID"
kill -TERM -- "-$PGID" 2>/dev/null || true

# Wait up to 5 seconds for graceful exit.
for _ in 1 2 3 4 5; do
  sleep 1
  if ! kill -0 "-$PGID" 2>/dev/null; then
    echo "pgid $PGID exited gracefully"
    exit 0
  fi
done

echo "sending SIGKILL to pgid $PGID"
kill -KILL -- "-$PGID" 2>/dev/null || true
echo "pgid $PGID killed"
