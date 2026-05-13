#!/usr/bin/env bash
# release-slot.sh <project> <slot>

set -euo pipefail

[[ $# -ne 2 ]] && { echo "Usage: release-slot.sh <project> <slot>" >&2; exit 2; }
PROJECT="$1"
SLOT="$2"

SLOT_DIR="$HOME/.cache/cc-skills/dev-up/$PROJECT/slots/$SLOT"
if [[ ! -d "$SLOT_DIR" ]]; then
  echo "slot $SLOT for $PROJECT was not reserved (nothing to release)" >&2
  exit 0
fi

rm -rf "$SLOT_DIR"
echo "released slot $SLOT for $PROJECT"
