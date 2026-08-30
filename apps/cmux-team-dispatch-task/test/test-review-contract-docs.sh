#!/usr/bin/env bash
# Review trust-boundary behavior must be described consistently at all entry points.
#
# RD5/RD6 extend that to the two decisions that changed how a Codex child is driven:
# no parallel directive is sent to Codex, and a stalled child is nudged once. Both are
# behavior a reader acts on, so all four entry docs must agree about them.
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

# RD5: Codex gets no parallel directive, and every doc says so. A doc that still promises
# spawn_agent to a codex child sends the reader looking for behavior that was removed.
rd5=0
for doc in "${DOCS[@]}"; do
  rel="${doc#"$ROOT/"}"
  flat=$(tr '\n' ' ' < "$doc" | tr -s ' ')
  # 主張そのものを探す: 「codex には並列を指示しない」と読める一文があること
  if [[ "$flat" == *'並列を指示しない'* || "$flat" == *'並列レビューを指示しない'* \
     || "$flat" == *'prints nothing and exits 0'* || "$flat" == *'空出力'* ]]; then
    :
  else
    bad "RD5 $rel does not state that codex receives no parallel directive"; rd5=1
  fi
  # 起動プロンプトに spawn_agent が届くと読める記述が残っていないこと
  if grep -qE 'codex (には|sessions are told to use) .{0,20}(spawn_agent|`spawn_agent`)' "$doc"; then
    bad "RD5 $rel still promises spawn_agent to codex children"; rd5=1
  fi
done
[[ $rd5 -ne 0 ]] || ok 'RD5 all four entry docs agree that codex receives no parallel directive'

# RD6: the stall-detection contract (work signal + one nudge) is stated everywhere.
rd6=0
for doc in "${DOCS[@]}"; do
  rel="${doc#"$ROOT/"}"
  flat=$(tr '\n' ' ' < "$doc" | tr -s ' ')
  [[ "$flat" == *'work-signal'* ]] || { bad "RD6 $rel omits work-signal"; rd6=1; }
  [[ "$flat" == *'dispatch-nudge'* ]] || { bad "RD6 $rel omits the dispatch-nudge label"; rd6=1; }
done
[[ $rd6 -ne 0 ]] || ok 'RD6 all four entry docs state the work-signal / dispatch-nudge contract'

# RD7: レビューペインに assignment marker を作らせない。
# runner wrapper の standby 所有権判定は `.assigned-<slug>` の存在だけを見るので、
# レビュアーの marker を作ると review ペインが共有 status.json の所有者に化ける。
# 2026-08-28 実測: Phase A-R の指示でレビュアー marker が作られ、exec の error を
# design_review が自分の終端状態として親へ通知し、exec_review へ abort まで送った。
# 禁止側は SKILL.md の命令文だけを見る。guide-ja.md にはこの命令が元から無く、緩い
# 語彙一致にすると事故の事後解説そのものが引っかかる (実際に引っかかった)。
rd7=0
skill_flat=$(tr '\n' ' ' < "$SKILL" | tr -s ' ')
if [[ "$skill_flat" == *'touch the assignment marker, and send exactly one review-plan'* ]]; then
  bad "RD7 SKILL.md still tells the requester to create an assignment marker for the review pane"
  rd7=1
fi
for doc in "$SKILL" "$GUIDE"; do
  rel="${doc#"$ROOT/"}"
  flat=$(tr '\n' ' ' < "$doc" | tr -s ' ')
  if [[ "$flat" == *'never'*'assignment marker'*'review'* \
     || "$flat" == *'レビューペインに assignment marker を作らない'* ]]; then
    :
  else
    bad "RD7 $rel does not state that review panes get no assignment marker"; rd7=1
  fi
done
[[ $rd7 -ne 0 ]] || ok 'RD7 review panes are documented as never receiving an assignment marker'

exit "$fail"
