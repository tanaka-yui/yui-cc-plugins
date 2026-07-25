#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SK="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
for needle in '--loop' 'references/loop-mode.md' 'issue-fetch.sh' 'render-loop-prompt.sh'; do
  grep -Fq -- "$needle" "$SK/SKILL.md" || { echo "FAIL: $needle"; exit 1; }
done
for needle in 'issue-fetch.sh' 'batch-wait.sh' 'loop-cleanup.sh' 'render-loop-prompt.sh' '--state-file' 'lock-acquire' 'init' 'ALL_TERMINAL' '--timeout-sentinel' '--unattended'; do
  grep -Fq -- "$needle" "$SK/references/loop-mode.md" || { echo "FAIL: $needle"; exit 1; }
done
echo '--- all tests passed ---'
