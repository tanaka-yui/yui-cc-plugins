#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo body > "$TMP/body.md"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
run() { bash "$RENDER" --slug issue-1-test --issue 1 --issue-title test --issue-url https://x/1 --issue-body-file "$TMP/body.md" --plan-hint "$TMP/plan.md" --exec-choice sonnet --design-engine "$1" --review "$2" --status-dir "$TMP/status" --timeout-sentinel "$TMP/sentinel" --team demo --layout workspace --parent-workspace workspace:1 --skill-dir "$SKILL" ${3:+--review-model gpt-5.6-sol --review-runner codex --review-pane-agent issue-1-review}; }
for design in claude codex; do
  for review in on off; do
    args=""; [[ "$review" == on ]] && args=review
    out=$(run "$design" "$review" "$args")
    [[ "$out" != *AskUserQuestion* && "$out" != *'{{'* ]] || { echo "FAIL: R1 $design/$review"; exit 1; }
    [[ "$out" == *'Task slug: issue-1-test'* && "$out" == *'Issue body:'* ]] || { echo "FAIL: R2 $design/$review"; exit 1; }
  done
done
out=$(run claude off)
[[ "$out" != *'Review is enabled'* ]] || { echo 'FAIL: R3 review off'; exit 1; }
[[ "$out" == *'STATUS PROTOCOL:'* && "$out" == *'status=executing'* && "$out" == *'status=done or status=error'* && "$out" == *'result.md'* ]] || { echo 'FAIL: R4 status protocol'; exit 1; }
echo '--- all tests passed ---'
