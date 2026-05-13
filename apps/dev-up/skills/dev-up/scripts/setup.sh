#!/usr/bin/env bash
# setup.sh — points to the setup guide. The actual setup is performed by Claude
# (LLM) reading references/setup-guide.md and self-driving via AskUserQuestion +
# Read/Write/Edit tools.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUIDE="$SCRIPT_DIR/../../../references/setup-guide.md"

if [[ ! -f "$GUIDE" ]]; then
  echo "ERROR: setup guide not found at $GUIDE" >&2
  exit 1
fi

cat <<EOF
dev-up setup must be driven by Claude (LLM).

This script does not perform the setup directly. Instead, Claude reads the
setup guide and runs through it interactively, prompting the user via
AskUserQuestion where decisions are needed.

If you are seeing this message in a terminal, please ask Claude to:
  Read $GUIDE and follow the procedure to generate .dev-up.yaml.
EOF
