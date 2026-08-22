#!/usr/bin/env bash
# render-loop-prompt.sh の prewarm snapshot と 4 role block の契約を検査する。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/render-loop-prompt.sh"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/status"
printf 'body\n' > "$TMP/body.md"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON

fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

render() {
  bash "$RENDER" --prewarm "$1" --slug t --issue 1 --issue-title test \
    --issue-url https://x/1 --issue-body-file "$TMP/body.md" --plan-hint "$TMP/plan.md" \
    --status-dir "$TMP/status" --timeout-sentinel "$TMP/sentinel" --team demo \
    --layout workspace --parent-workspace workspace:1 --skill-dir "$SKILL" "${@:2}"
}
render_ok() { render "$1" 2> "$TMP/err"; }

mk_prewarm() { # $1=design engine $2=exec engine
  local dr er
  [[ "$1" == claude ]] && dr=ccf || dr=cx
  [[ "$2" == claude ]] && er=ccf || er=cx
  jq -n --arg de "$1" --arg ee "$2" --arg dr "$dr" --arg er "$er" '{
    workspace_id:"workspace:1", review_mode:"off",
    design:{surface_id:"s1",agent:"t",runner:$dr,engine:$de,model:"m",effort:"xhigh",wired:true},
    exec:{surface_id:"s2",agent:"t-exec",runner:$er,engine:$ee,model:"m",effort:"high",wired:true}}'
}

FULL_OFF="$TMP/full-off.json"
FULL_ON="$TMP/full-on.json"
mk_prewarm claude codex > "$FULL_OFF"
jq '.review_mode = "on" |
  .design_review = {surface_id:"s3",agent:"t-design-review",runner:"cx",engine:"codex",model:"DR-MODEL",effort:"xhigh",wired:true} |
  .exec_review = {surface_id:"s4",agent:"t-exec-review",runner:"ccf",engine:"claude",model:"XR-MODEL",effort:"high",wired:true}' \
  "$FULL_OFF" > "$FULL_ON"

# LP1: --prewarm is mandatory and all legacy role flags are rejected.
render "$FULL_OFF" >/dev/null 2>&1 || bad 'LP1a: valid --prewarm was rejected'
bash "$RENDER" --slug t >/dev/null 2>&1 && bad 'LP1b: missing --prewarm was accepted' || ok 'LP1b: --prewarm is required'
for old in --design-runner --design-engine --exec-runner --exec-engine --review --review-model --review-runner --review-engine --review-pane-agent --exec-choice; do
  render "$FULL_OFF" "$old" legacy >/dev/null 2>&1 \
    && bad "LP1c: legacy flag $old was accepted" || :
done
ok 'LP1c: legacy role flags are rejected'

# LP2: phase selection follows the design role only.
mk_prewarm claude codex > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'Claude design runner' <<< "$out" && ok 'LP2a: design=claude selects claude phase block' || bad 'LP2a'
mk_prewarm codex claude > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'Codex design runner' <<< "$out" && ok 'LP2b: design=codex selects codex phase block' || bad 'LP2b'

# LP3/LP4: sparse review roles render independently; on-mode omissions warn.
out=$(render_ok "$FULL_ON")
grep -q 'Phase A-R.*design-review' <<< "$out" && grep -q 'Phase B-R.*exec-review' <<< "$out" \
  && ok 'LP3a: both review blocks are rendered' || bad 'LP3a'
jq 'del(.exec_review)' "$FULL_ON" > "$TMP/p.json"
out=$(render_ok "$TMP/p.json"); err=$(cat "$TMP/err")
grep -q 'Phase A-R.*design-review' <<< "$out" && ! grep -q 'Phase B-R.*exec-review' <<< "$out" \
  && grep -qi 'warn' <<< "$err" && ok 'LP3b/LP4a: missing exec_review warns and keeps design_review' || bad 'LP3b/LP4a'
jq 'del(.design_review)' "$FULL_ON" > "$TMP/p.json"
out=$(render_ok "$TMP/p.json")
grep -q 'Phase B-R.*exec-review' <<< "$out" && ! grep -q 'Phase A-R.*design-review' <<< "$out" \
  && ok 'LP3c: missing design_review keeps exec_review' || bad 'LP3c'
render_ok "$FULL_OFF" >/dev/null; err=$(cat "$TMP/err")
grep -qi 'warn' <<< "$err" && bad 'LP4b: review_mode=off emitted a warning' || ok 'LP4b: review_mode=off does not warn'

# LP5: codex design/exec may omit model; active reviewers may not.
mk_prewarm codex codex | jq 'del(.design.model, .exec.model)' > "$TMP/p.json"
render_ok "$TMP/p.json" >/dev/null && ok 'LP5a: codex design/exec model omission is accepted' || bad 'LP5a'
jq 'del(.design_review.model)' "$FULL_ON" > "$TMP/p.json"
render_ok "$TMP/p.json" >/dev/null 2>&1 && bad 'LP5b: active review model omission was accepted' || ok 'LP5b: active review model is required'

# LP6: each active reviewer requires all five routing fields.
lp6_fail=0
for role in design_review exec_review; do
  for field in runner engine model effort agent; do
    jq --arg role "$role" --arg field "$field" 'del(.[$role][$field])' "$FULL_ON" > "$TMP/p.json"
    render_ok "$TMP/p.json" >/dev/null 2>&1 && { bad "LP6: $role.$field omission was accepted"; lp6_fail=1; }
  done
done
[[ $lp6_fail -eq 0 ]] && ok 'LP6: both reviewers require runner/engine/model/effort/agent'

# LP7: reviewer tuples stay attached to their own blocks.
out=$(render_ok "$FULL_ON")
dr_block=$(sed -n '/Phase A-R.*design-review/,/^$/p' <<< "$out")
xr_block=$(sed -n '/Phase B-R.*exec-review/,/^$/p' <<< "$out")
if grep -q 'DR-MODEL' <<< "$dr_block" && ! grep -q 'XR-MODEL' <<< "$dr_block" \
  && grep -q 'XR-MODEL' <<< "$xr_block" && ! grep -q 'DR-MODEL' <<< "$xr_block"; then
  ok 'LP7: reviewer tuples reach separate blocks'
else
  bad 'LP7: reviewer tuples were mixed'
fi

# LP7b: verified exec tuple is self-contained in the rendered prompt. A child must not
# reopen live prewarm.json, and the removed spawn path must not be advertised.
out=$(render_ok "$FULL_ON")
for expected in 'Exec surface: s2' 'Exec agent: t-exec' 'Exec runner: cx' \
                'Exec engine: codex' 'Exec model: m' 'Exec effort: high'; do
  grep -Fq -- "$expected" <<< "$out" || bad "LP7b: missing verified tuple field: $expected"
done
if grep -Eq 'inspect .*prewarm\.json|Spawn fallback' <<< "$out"; then
  bad 'LP7b: rendered prompt tells the child to reread live prewarm or spawn'
else
  ok 'LP7b: rendered prompt embeds exec tuple and has no live reread/spawn fallback'
fi

# LP7c: review_mode=off cannot be contradicted by stale/replaced review keys.
jq '.review_mode = "off"' "$FULL_ON" > "$TMP/p.json"
if render_ok "$TMP/p.json" >/dev/null 2>&1; then
  bad 'LP7c: review_mode=off with review roles was accepted'
else
  ok 'LP7c: review_mode=off with review roles is rejected'
fi

# Existing prompt invariants remain in every phase selection.
for prewarm in "$FULL_OFF" "$FULL_ON"; do
  out=$(render_ok "$prewarm")
  [[ "$out" != *AskUserQuestion* && "$out" != *'{{'* ]] || bad 'LP8: unresolved interactive/template text'
  [[ "$out" == *'Task slug: t'* && "$out" == *'Issue body:'* ]] || bad 'LP8: task header/body'
  [[ "$out" == *'agmsg/scripts/send.sh'* && "$out" != *'cmux send'* ]] || bad 'LP8: agmsg-only delivery instruction'
  [[ "$out" == *'STATUS PROTOCOL:'* && "$out" == *'status=executing'* && "$out" == *'result.md'* ]] || bad 'LP9: status protocol'
  [[ $(grep -Foc 'Common unattended rules:' <<< "$out" || true) == 1 ]] || bad 'LP9: common rules count'
done
ok 'LP8/LP9: existing delivery and status protocols remain'

exit "$fail"
