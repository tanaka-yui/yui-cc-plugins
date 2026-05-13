#!/usr/bin/env bash
# topo-sort.sh — topological sort of services by depends_on.
# Reads .dev-up.yaml from $1 and prints service names in start order, one per line.

set -euo pipefail

CONFIG_FILE="$1"

# Build "dependency target" pairs for tsort: "<dep> <service>" means <dep> must come before <service>.
# Handle two cases:
# 1. Services with depends_on: emit "dep service_name" for each dependency
# 2. Services without depends_on: emit "service_name service_name" to ensure it appears in output
PAIRS=$(
  (yq eval '.services[] | select(.depends_on) | .depends_on[] as $dep | "\($dep) \(.name)"' "$CONFIG_FILE" -r; \
   yq eval '.services[] | select(.depends_on == null) | "\(.name) \(.name)"' "$CONFIG_FILE" -r) 2>/dev/null || true
)

# tsort: dependencies first.
# Note: some versions of tsort exit 0 even on cycles, so check output for cycle detection.
result=$(echo "$PAIRS" | tsort 2>&1)
if echo "$result" | grep -q "cycle"; then
  echo "ERROR: depends_on graph has a cycle:" >&2
  echo "$result" >&2
  exit 1
fi

echo "$result"
