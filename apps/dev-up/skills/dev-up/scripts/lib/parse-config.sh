#!/usr/bin/env bash
# parse-config.sh — read .dev-up.yaml and emit shell-eval-able variables.
# Usage: eval "$(bash parse-config.sh <path-to-.dev-up.yaml>)"

set -euo pipefail

CONFIG_FILE="${1:-}"
[[ -z "$CONFIG_FILE" || ! -f "$CONFIG_FILE" ]] && { echo "ERROR: config file not found: $CONFIG_FILE" >&2; exit 1; }
command -v yq >/dev/null 2>&1 || { echo "ERROR: yq not installed. Run: brew install yq" >&2; exit 1; }

# Top-level scalars.
echo "DEVUP_PROJECT=$(yq -r '.project' "$CONFIG_FILE")"
echo "DEVUP_SLOT_MIN=$(yq -r '.slot_range[0]' "$CONFIG_FILE")"
echo "DEVUP_SLOT_MAX=$(yq -r '.slot_range[1]' "$CONFIG_FILE")"
echo "DEVUP_OFFSET=$(yq -r '.offset_per_slot' "$CONFIG_FILE")"

# Service names (one per line, newline-separated).
echo "DEVUP_SERVICES=( $(yq -r '.services[].name' "$CONFIG_FILE" | tr '\n' ' ') )"
