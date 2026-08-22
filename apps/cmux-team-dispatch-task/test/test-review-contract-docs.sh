#!/usr/bin/env bash
# Review trust-boundary behavior must be described consistently at all entry points.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILL="$ROOT/apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/SKILL.md"
GUIDE="$ROOT/apps/cmux-team-dispatch-task/skills/cmux-team-dispatch-task/references/guide-ja.md"
README="$ROOT/apps/cmux-team-dispatch-task/README.md"
CLAUDE="$ROOT/apps/cmux-team-dispatch-task/CLAUDE.md"
DOCS=("$SKILL" "$GUIDE" "$README" "$CLAUDE")
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

for doc in "${DOCS[@]}"; do
  rel="${doc#"$ROOT/"}"
  for helper in review-gate.sh prune-not-ready.sh phase-b-deliver.sh; do
    grep -Fq -- "$helper" "$doc" || bad "RD1 $rel omits $helper"
  done
done
[[ $fail -ne 0 ]] || ok 'RD1 all four entry docs name the three review-boundary helpers'

stale='REVIEW_CONFIG_ARGS|VERDICT: approved|proceed only on approved|launcher arguments|launcher へそのまま'
if grep -nE "$stale" "${DOCS[@]}"; then
  bad 'RD2 stale launcher/verdict behavior remains'
else
  ok 'RD2 stale launcher/verdict behavior is absent'
fi

skill_flat=$(tr '\n' ' ' < "$SKILL" | tr -s ' ')
if [[ "$skill_flat" == *'REVIEW_CONFIG_PATH=$(bash <SKILL_DIR>/scripts/review-gate.sh'* \
   && "$skill_flat" == *'bash <SKILL_DIR>/scripts/phase-b-deliver.sh'* \
   && "$skill_flat" == *'--review-config "$REVIEW_CONFIG_PATH"'* ]]; then
  ok 'RD3 gate output is passed to the prewarmed Phase B delivery helper'
else
  bad 'RD3 gate output is not wired to Phase B delivery'
fi

for doc in "${DOCS[@]}"; do
  rel="${doc#"$ROOT/"}"
  flat=$(tr '\n' ' ' < "$doc" | tr -s ' ')
  if [[ "$flat" == *'code-round-N.md'* && "$flat" == *'VERDICT: approve'* \
     && "$flat" == *'VERDICT: needs_work'* \
     && ( "$flat" == *'maximum of 5 rounds'* || "$flat" == *'at most five rounds'* \
       || "$flat" == *'最大 5 ラウンド'* || "$flat" == *'最大五ラウンド'* ) \
     && ( "$flat" == *'Do not start round 6'* || "$flat" == *'第 6 ラウンドは開始しない'* \
       || "$flat" == *'第 6 ラウンドは 開始しない'* || "$flat" == *'第 6 ラウンドは開始しません'* ) ]]; then
    :
  else
    bad "RD4 $rel omits the concrete Phase B-R terminal contract"
  fi
done
[[ $fail -ne 0 ]] || ok 'RD4 all four entry docs state findings path, verdicts, cap, and terminal rule'

exit "$fail"
