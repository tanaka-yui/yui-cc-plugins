#!/usr/bin/env bash
# review-gate.sh の非空出力を、prewarmed exec への唯一の Phase B request へ配線する。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
S_REAL=$(cd "$S" && pwd -P)
GATE="$S/review-gate.sh"
DELIVER="$S/phase-b-deliver.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/status" "$TMP/bin"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                                  {"name":"cx","command":"codex","engine":"codex"}]}
JSON
cat > "$TMP/prewarm.json" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"surface:1","agent":"t","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "exec":{"surface_id":"surface:3","agent":"t-exec","runner":"ccf","engine":"claude","model":"sonnet","effort":"high","wired":true},
 "exec_review":{"surface_id":"surface:4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true}}
JSON
printf '%s\n' '# plan' > "$TMP/plan.md"
cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf 'call\n' >> "$SEND_CALLS"
printf '%s\0' "$#" "$@" > "$SEND_ARGS"
[[ -z "${FAIL_SEND:-}" ]]
STUB
chmod +x "$TMP/bin/send.sh"

gate_output=$(bash "$GATE" --prewarm "$TMP/prewarm.json" --ready exec_review \
  --status-dir "$TMP/status" --slug t --team tm --reviewer-workspace workspace:1)
review_dir_real=$(cd "$TMP/status/review" && pwd -P)

[[ -f "$DELIVER" ]] || { bad "PB0 missing production delivery script: $DELIVER"; exit "$fail"; }

export SEND_CALLS="$TMP/send.calls" SEND_ARGS="$TMP/send.args"
AGMSG_SEND="$TMP/bin/send.sh" \
  bash "$DELIVER" --prewarm "$TMP/prewarm.json" --review-config "$gate_output" \
    --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t >/dev/null 2>"$TMP/deliver.err"
rc=$?

read_nul_args() {
  SEND=()
  while IFS= read -r -d '' value; do SEND+=("$value"); done < "$SEND_ARGS"
}
read_nul_args
body="${SEND[4]-}"
[[ $rc -eq 0 && $(wc -l < "$TMP/send.calls" | tr -d ' ') == 1 && "${SEND[0]-}" == 4 ]] \
  && ok 'PB1 gate output reaches exactly one four-argument send call' \
  || bad "PB1 rc=$rc calls=$(wc -l < "$TMP/send.calls" 2>/dev/null | tr -d ' ') argc=${SEND[0]-missing}"
[[ "${SEND[1]-}" == tm && "${SEND[2]-}" == t && "${SEND[3]-}" == t-exec ]] \
  && ok 'PB2 delivery targets the verified prewarmed exec agent' || bad 'PB2 wrong send tuple'
[[ $(grep -Fo 'phase-b-exec:' <<< "$body" | wc -l | tr -d ' ') == 1 ]] \
  && ok 'PB3 phase-b-exec prefix appears exactly once' || bad 'PB3 duplicate/missing phase-b-exec prefix'
[[ "$body" == *"$review_dir_real/code-round-N.md"* \
  && "$body" == *'maximum of 5 rounds'* && "$body" == *'Do not start round 6'* \
  && "$body" == *'VERDICT: approve'* && "$body" == *'t-exec-review'* ]] \
  && ok 'PB4 concrete findings path, verdict, cap, terminal rule, and reviewer are embedded' \
  || bad 'PB4 incomplete Phase B-R protocol'
review_send_contract="passing exactly four arguments in this order: team tm, sender t-exec, recipient t-exec-review, and the whole review-code: message as one argument"
verdict_send_contract="passing exactly four arguments in this order: team tm, sender t-exec-review, recipient t-exec, and the whole review-verdict: message as one argument"
claude_liveness='cmux read-screen --workspace workspace:1 --surface surface:4'
if [[ $(grep -Fo "$review_send_contract" <<< "$body" | wc -l | tr -d ' ') == 1 \
   && $(grep -Fo "$verdict_send_contract" <<< "$body" | wc -l | tr -d ' ') == 1 \
   && $(grep -Fo 'After each successful review-code: send, stop and wait for the review-verdict: push.' <<< "$body" | wc -l | tr -d ' ') == 1 \
   && $(grep -Fo 'On every wake, re-read' <<< "$body" | wc -l | tr -d ' ') == 1 \
   && $(grep -Fo 'arm ONE single-shot safety timer with the Bash tool using run_in_background' <<< "$body" | wc -l | tr -d ' ') == 1 \
   && $(grep -Fo "$claude_liveness" <<< "$body" | wc -l | tr -d ' ') == 1 \
   && "$body" != *'one dispatch-notify: body reporting an unbacked code review wait'* ]]; then
  ok 'PB4b actual delivery embeds the complete wait protocol exactly once'
else
  bad 'PB4b actual delivery is missing or duplicates the complete wait protocol'
fi
# completion-gate.sh は「レビュー待ち」をディスクだけで判定し、その材料は
# <point>-round-<N>-request.md である。Phase A-R は依頼文を書くのでこれが成立するが、
# Phase B-R は依頼を agmsg メッセージだけで送っていたため、verdict を待つ実装者が判定 7 に
# 落ちて毎ターン block され、block 文面が勧める error を書いて中断した (2026-08-28 実測)。
# 依頼を送る前に request ファイルを書かせることが、その待機を materialize する唯一の手段。
if [[ "$body" == *"$review_dir_real/code-round-N-request.md"* \
   && "$body" == *'before that send'* ]]; then
  ok 'PB4e review request is materialized on disk before the send'
else
  bad 'PB4e delivery does not make the implementer write code-round-N-request.md'
fi
status_file="$TMP/status/status.json"
result_file="$TMP/status/result.md"
done_command="bash $S_REAL/report-status.sh $TMP/status done"
error_command="bash $S_REAL/report-status.sh $TMP/status error"
if [[ "$body" == *"write $status_file with status executing"* \
   && "$body" == *"write $result_file"* \
   && "$body" == *"$done_command"* && "$body" == *"$error_command"* \
   && "$body" == *'preserve an existing pr_url'* \
   && "$body" == *'finished (status: done)'* && "$body" == *'finished (status: error)'* \
   && "$body" == *'retry once'* ]]; then
  ok 'PB4c actual delivery embeds executing, result, terminal status, and parent notification protocol'
else
  bad 'PB4c actual delivery omits part of the status/result/notification protocol'
fi
# 中断記録は reviewer の出力先を奪ってはならない。2026-08-28 に実測: 打ち切った実装者が
# code-round-3.md へ中断メモを書き、進行中だったレビューの出力先を潰した (親が手作業で
# code-round-3-final.md へ退避させた)。記録の宛先は -abort.md で、findings は reviewer のもの。
if [[ "$body" == *"write the stop reason to $review_dir_real/code-round-N-abort.md"* \
   && "$body" != *"write the stop reason to $review_dir_real/code-round-N.md"* \
   && "$body" == *'abort-reviewer: [abort]'* \
   && "$body" == *"$error_command"* && "$body" == *'finished (status: error)'* ]]; then
  ok 'PB4d actual delivery embeds the review-abort terminal protocol'
else
  bad 'PB4d actual delivery omits part of the review-abort terminal protocol'
fi
[[ -f "$TMP/status/.assigned-t-exec" && -f "$TMP/status/.deferred" ]] \
  && ok 'PB5 assignment precedes successful delegation and deferred is recorded' \
  || bad 'PB5 assignment/deferred markers missing'

rm -f "$TMP/status/.deferred" "$TMP/send.calls" "$TMP/send.args"
if AGMSG_SEND="$TMP/bin/send.sh" FAIL_SEND=1 \
   bash "$DELIVER" --prewarm "$TMP/prewarm.json" --review-config "$gate_output" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/send-fail.err"; then
  bad 'PB6 send failure was accepted'
else
  [[ ! -e "$TMP/status/.deferred" && $(wc -l < "$TMP/send.calls" | tr -d ' ') == 1 ]] \
    && ok 'PB6 send failure is not retried and does not mark deferred' \
    || bad 'PB6 send failure ownership is wrong'
fi

# A review_mode=off snapshot may deliver the base Phase B request, but must not contain
# review role keys. This protects the same snapshot trust boundary as renderer/cleanup.
jq 'del(.exec_review) | .review_mode = "off"' "$TMP/prewarm.json" > "$TMP/prewarm-off.json"
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm-off.json" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/off.err"; then
  read_nul_args
  body="${SEND[4]-}"
  [[ $(wc -l < "$TMP/send.calls" | tr -d ' ') == 1 && "$body" != *'MANDATORY CODE REVIEW'* ]] \
    && ok 'PB7 review_mode off delivers one base request without Phase B-R' \
    || bad 'PB7 off-mode base delivery has the wrong request'
else
  bad "PB7 off-mode base delivery failed: $(tr '\n' ' ' < "$TMP/off.err")"
fi

jq '.review_mode = "off"' "$TMP/prewarm.json" > "$TMP/prewarm-off-bad.json"
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm-off-bad.json" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/off-bad.err"; then
  bad 'PB8 review_mode off with review roles was accepted'
elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.deferred" ]]; then
  ok 'PB8 review_mode off with review roles is rejected before delivery'
else
  bad 'PB8 invalid off-mode snapshot caused delivery side effects'
fi

malicious_model="bad'; touch $TMP/model-pwn; #"
jq --arg value "$malicious_model" '.exec.model = $value' "$TMP/prewarm.json" > "$TMP/prewarm-bad-model.json"
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm-bad-model.json" --review-config "$gate_output" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/bad-model.err"; then
  bad 'PB9 unsafe exec model was accepted'
elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.deferred" && ! -e "$TMP/model-pwn" ]]; then
  ok 'PB9 unsafe exec model is rejected before delivery without shell side effects'
else
  bad 'PB9 unsafe exec model caused delivery or shell side effects'
fi

mkdir -p "$TMP/outside-review"
outside_review=$(cd "$TMP/outside-review" && pwd -P)
jq --arg value "$outside_review" '.review_dir = $value' "$gate_output" \
  > "$TMP/outside-review/code-review.json"
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm.json" \
     --review-config "$TMP/outside-review/code-review.json" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/outside-review.err"; then
  bad 'PB10 review config outside the status review directory was accepted'
elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.deferred" ]]; then
  ok 'PB10 delivery re-proves canonical status review containment'
else
  bad 'PB10 outside review config caused delivery side effects'
fi

ln -s "$TMP/status" "$TMP/status-link"
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm.json" \
     --review-config "$TMP/status-link/review/code-review.json" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status-link" --team tm --slug t \
     >/dev/null 2>"$TMP/status-link.err"; then
  bad 'PB11 symlink status directory was accepted'
elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.deferred" ]]; then
  ok 'PB11 symlink status directory is rejected before delivery'
else
  bad 'PB11 symlink status directory caused delivery side effects'
fi

assert_invalid_snapshot() { # label, jq filter
  local label="$1" filter="$2" file="$TMP/prewarm-invalid.json"
  jq "$filter" "$TMP/prewarm.json" > "$file"
  rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.deferred"
  if AGMSG_SEND="$TMP/bin/send.sh" \
     bash "$DELIVER" --prewarm "$file" --review-config "$gate_output" \
       --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
       >/dev/null 2>"$TMP/prewarm-invalid.err"; then
    bad "PB12-$label invalid complete snapshot was accepted"
  elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.deferred" ]]; then
    ok "PB12-$label invalid complete snapshot is rejected before delivery"
  else
    bad "PB12-$label invalid complete snapshot caused delivery side effects"
  fi
}

assert_invalid_snapshot top-key '.unexpected = true'
assert_invalid_snapshot missing-design 'del(.design)'
assert_invalid_snapshot design-key '.design.unexpected = true'
assert_invalid_snapshot design-wired '.design.wired = false'
assert_invalid_snapshot design-agent '.design.agent = "other"'
assert_invalid_snapshot design-runner '.design.runner = "missing"'
assert_invalid_snapshot design-engine '.design.engine = "codex"'
assert_invalid_snapshot design-model '.design.model = " bad"'
assert_invalid_snapshot design-effort '.design.effort = "minimal"'
assert_invalid_snapshot exec-review-key '.exec_review.unexpected = true'
assert_invalid_snapshot exec-review-wired '.exec_review.wired = false'
assert_invalid_snapshot exec-review-effort '.exec_review.effort = "minimal"'
assert_invalid_snapshot workspace-id '.workspace_id = "workspace:not-safe!"'
assert_invalid_snapshot duplicate-surface '.design.surface_id = .exec.surface_id'

# A surviving exec_review tuple is usable by definition. Omitting the gate output must
# fail closed before assignment or delivery instead of silently disabling mandatory review.
rm -f "$TMP/send.calls" "$TMP/send.args" "$TMP/status/.assigned-t-exec" "$TMP/status/.deferred"
if AGMSG_SEND="$TMP/bin/send.sh" \
   bash "$DELIVER" --prewarm "$TMP/prewarm.json" \
     --plan-file "$TMP/plan.md" --status-dir "$TMP/status" --team tm --slug t \
     >/dev/null 2>"$TMP/missing-review-config.err"; then
  bad 'PB13 usable exec_review without --review-config was accepted'
elif [[ ! -e "$TMP/send.calls" && ! -e "$TMP/status/.assigned-t-exec" \
     && ! -e "$TMP/status/.deferred" ]]; then
  ok 'PB13 usable exec_review requires --review-config before assignment or delivery'
else
  bad 'PB13 missing review config caused delivery side effects'
fi

deliver_mixed_body() { # $1=prewarm $2=status dir
  local prewarm="$1" status="$2" config
  mkdir -p "$status"
  config=$(bash "$GATE" --prewarm "$prewarm" --ready exec_review \
    --status-dir "$status" --slug t --team tm --reviewer-workspace workspace:1)
  rm -f "$TMP/send.calls" "$TMP/send.args"
  AGMSG_SEND="$TMP/bin/send.sh" bash "$DELIVER" --prewarm "$prewarm" \
    --review-config "$config" --plan-file "$TMP/plan.md" --status-dir "$status" \
    --team tm --slug t >/dev/null 2>"$status/deliver.err" || return 1
  read_nul_args
  printf '%s' "${SEND[4]-}"
}

# Codex implementer + Claude reviewer: Claude has no Codex bridge seat. The verified
# surface must be checked once, and the Codex-only seat helper must not appear.
jq '.exec.runner = "cx" | .exec.engine = "codex" | .exec.model = "gpt-5.6-sol"' \
  "$TMP/prewarm.json" > "$TMP/prewarm-codex-claude.json"
mixed_body=$(deliver_mixed_body "$TMP/prewarm-codex-claude.json" "$TMP/status-codex-claude")
codex_liveness="bash $S_REAL/verify-agmsg-ready.sh --codex --team tm --name t-exec-review"
if [[ $(grep -Fo "$claude_liveness" <<< "$mixed_body" | wc -l | tr -d ' ') == 1 \
   && "$mixed_body" != *"$codex_liveness"* \
   && $(grep -Fo 'this engine has no timer' <<< "$mixed_body" | wc -l | tr -d ' ') == 1 ]]; then
  ok 'PB14a Codex implementer waits for a Claude reviewer via the verified surface once'
else
  bad 'PB14a Codex-to-Claude review wait uses the wrong liveness protocol'
fi

# Claude implementer + Codex reviewer: the Codex bridge seat is the reachable contract,
# while the Claude implementer still owns exactly one single-shot timer.
jq '.exec_review.runner = "cx" | .exec_review.engine = "codex" | .exec_review.model = "gpt-5.6-sol"' \
  "$TMP/prewarm.json" > "$TMP/prewarm-claude-codex.json"
mixed_body=$(deliver_mixed_body "$TMP/prewarm-claude-codex.json" "$TMP/status-claude-codex")
if [[ $(grep -Fo "$codex_liveness" <<< "$mixed_body" | wc -l | tr -d ' ') == 1 \
   && "$mixed_body" != *"$claude_liveness"* \
   && $(grep -Fo 'arm ONE single-shot safety timer with the Bash tool using run_in_background' \
        <<< "$mixed_body" | wc -l | tr -d ' ') == 1 ]]; then
  ok 'PB14b Claude implementer waits for a Codex reviewer via its bridge seat once'
else
  bad 'PB14b Claude-to-Codex review wait uses the wrong liveness protocol'
fi

# PB15b: a Codex reviewer gets no parallel directive, so the sentence that would have
# carried it must disappear with it. An empty "reviewer-only directive" wrapper is worse
# than none: the implementer transcribes it into the review request as an empty order.
# $mixed_body is still the Claude-implementer / Codex-reviewer body from PB14b.
if [[ "$mixed_body" != *'reviewer-only directive'* ]]; then
  ok 'PB15b Codex reviewer leaves no empty reviewer-only directive wrapper'
else
  bad 'PB15b empty reviewer-only directive wrapper survived for a Codex reviewer'
fi

# PB15a: a Codex implementer gets no base directive either, and dropping it must not
# leave a doubled separator behind (the base concatenation uses ${PARALLEL:+...}).
codex_impl_body=$(deliver_mixed_body "$TMP/prewarm-codex-claude.json" "$TMP/status-codex-impl")
if [[ "$codex_impl_body" != *'PARALLEL EXECUTION, mandatory: whenever two or more pieces of work are independent, you MUST fan them out with spawn_agent'*    && "$codex_impl_body" == *"Read and execute the plan at $TMP/plan.md. MANDATORY STATUS PROTOCOL"* ]]; then
  ok 'PB15a Codex implementer gets no directive and no doubled separator'
else
  bad 'PB15a Codex implementer body kept a directive or a doubled separator'
fi

exit "$fail"
