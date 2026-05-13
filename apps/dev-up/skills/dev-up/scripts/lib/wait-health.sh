#!/usr/bin/env bash
# wait-health.sh — poll a health check until it passes or timeout.
# Usage: wait-health.sh <kind> <target> <timeout-sec> <interval-sec>
#   kind: http | tcp
#   target for http: full URL (e.g., http://localhost:8080/healthz)
#   target for tcp:  host:port (e.g., localhost:8080)

set -euo pipefail

KIND="$1"
TARGET="$2"
TIMEOUT="${3:-60}"
INTERVAL="${4:-1}"

elapsed=0
while (( elapsed < TIMEOUT )); do
  case "$KIND" in
    http)
      if curl -fsS --max-time 2 "$TARGET" -o /dev/null 2>/dev/null; then
        echo "health check passed: $KIND $TARGET (after ${elapsed}s)"
        exit 0
      fi
      ;;
    tcp)
      host="${TARGET%%:*}"
      port="${TARGET##*:}"
      if nc -z "$host" "$port" 2>/dev/null; then
        echo "health check passed: $KIND $TARGET (after ${elapsed}s)"
        exit 0
      fi
      ;;
    *)
      echo "WARN: unknown health_check kind: $KIND (skipping)" >&2
      exit 0
      ;;
  esac
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

echo "ERROR: health check timed out after ${TIMEOUT}s: $KIND $TARGET" >&2
exit 1
