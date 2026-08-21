#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo body > "$TMP/body.md"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
run() { bash "$RENDER" --slug issue-1-test --issue 1 --issue-title test --issue-url https://x/1 --issue-body-file "$TMP/body.md" --plan-hint "$TMP/plan.md" --exec-choice sonnet --design-runner "$1" --design-engine "$1" --exec-runner claude --exec-engine claude --review "$2" --status-dir "$TMP/status" --timeout-sentinel "$TMP/sentinel" --team demo --layout workspace --parent-workspace workspace:1 --skill-dir "$SKILL" ${3:+--review-model gpt-5.6-sol --review-runner codex --review-engine codex --review-pane-agent issue-1-review}; }
for design in claude codex; do
  for review in on off; do
    args=""; [[ "$review" == on ]] && args=review
    out=$(run "$design" "$review" "$args")
    [[ "$out" != *AskUserQuestion* && "$out" != *'{{'* ]] || { echo "FAIL: R1 $design/$review"; exit 1; }
    [[ "$out" == *'Task slug: issue-1-test'* && "$out" == *'Issue body:'* ]] || { echo "FAIL: R2 $design/$review"; exit 1; }
    # R5: 配送指示が agmsg send.sh の 1 回呼び出しであり、生の cmux send/send-key を含まない
    [[ "$out" == *'agmsg/scripts/send.sh'* ]] || { echo "FAIL: R5 agmsg send.sh の指示が無い $design/$review"; exit 1; }
    [[ "$out" != *'cmux send'* ]] || { echo "FAIL: R5 生の cmux send が残っている $design/$review"; exit 1; }
  done
done
out=$(run claude off)
[[ "$out" != *'Review is enabled'* ]] || { echo 'FAIL: R3 review off'; exit 1; }
[[ "$out" == *'STATUS PROTOCOL:'* && "$out" == *'status=executing'* && "$out" == *'status=done or status=error'* && "$out" == *'result.md'* ]] || { echo 'FAIL: R4 status protocol'; exit 1; }

common_rule='Common unattended rules: do not infer the review or execution role from the design engine. Do not request interactive input; record unresolved decisions in the result.'
for design in claude codex; do
  out=$(run "$design" off)
  count=$(printf '%s\n' "$out" | grep -Foc "$common_rule" || true)
  [[ "$count" == 1 ]] || { echo "FAIL: R6 common unattended rule count for $design: $count"; exit 1; }
  count=$(printf '%s\n' "$out" | grep -Foc 'do not infer' || true)
  [[ "$count" == 1 ]] || { echo "FAIL: R6 role inference rule count for $design: $count"; exit 1; }
  case "$design" in
    claude) [[ "$out" == *"Use Claude Code's plan workflow"* ]] || { echo 'FAIL: R7 Claude CLI mechanics'; exit 1; } ;;
    codex) [[ "$out" == *'Keep the resolved Codex model and reasoning effort'* ]] || { echo 'FAIL: R7 Codex CLI mechanics'; exit 1; } ;;
  esac
done

all_codex=$(bash "$RENDER" \
  --slug issue-1-all-codex --issue 1 --issue-title test --issue-url https://x/1 \
  --issue-body-file "$TMP/body.md" --plan-hint "$TMP/plan.md" \
  --design-runner codex --design-engine codex \
  --review on --review-model gpt-5.6-sol --review-runner codex --review-engine codex \
  --review-pane-agent issue-1-review \
  --exec-choice codex --exec-runner codex --exec-engine codex \
  --status-dir "$TMP/status" --timeout-sentinel "$TMP/sentinel" --team demo \
  --layout workspace --parent-workspace workspace:1 --skill-dir "$SKILL")
[[ "$all_codex" == *'Review engine: codex'* ]] || { echo 'FAIL: AC1 all-Codex review engine'; exit 1; }
for forbidden in 'Claude design pane' 'claude reviewer' 'selected sonnet' 'reviewer is always the opposite'; do
  [[ "$all_codex" != *"$forbidden"* ]] || { echo "FAIL: AC2 all-Codex prompt contains: $forbidden"; exit 1; }
done

assert_missing_review_field() {
  local missing="$1" output rc
  local review_args=(--review on)
  [[ "$missing" == model ]] || review_args+=(--review-model gpt-5.6-sol)
  [[ "$missing" == runner ]] || review_args+=(--review-runner codex)
  [[ "$missing" == engine ]] || review_args+=(--review-engine codex)
  [[ "$missing" == agent ]] || review_args+=(--review-pane-agent issue-1-review)
  set +e
  output=$(bash "$RENDER" \
    --slug issue-1-missing-review --issue 1 --issue-title test --issue-url https://x/1 \
    --issue-body-file "$TMP/body.md" --plan-hint "$TMP/plan.md" \
    --design-runner codex --design-engine codex \
    "${review_args[@]}" \
    --exec-choice codex --exec-runner codex --exec-engine codex \
    --status-dir "$TMP/status" --timeout-sentinel "$TMP/sentinel" --team demo \
    --layout workspace --parent-workspace workspace:1 --skill-dir "$SKILL" 2>&1)
  rc=$?
  set -e
  [[ $rc -ne 0 ]] || { echo "FAIL: RV1 missing review $missing was accepted"; exit 1; }
  [[ "$output" == *'review=on requires review model, runner, engine, and pane agent'* ]] \
    || { echo "FAIL: RV2 missing review $missing diagnostic: $output"; exit 1; }
}

for missing_review_field in model runner engine agent; do
  assert_missing_review_field "$missing_review_field"
done
echo '--- all tests passed ---'
