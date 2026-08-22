#!/usr/bin/env bash
# Fixed 2/4-pane layout and prewarm schema behavior.
# PI1 launch count; PI2 split table; PI3 role keys; PI4 agent names;
# PI5 no in-session collapse; PI6 optional reviewer launch failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"

run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
[[ "$(launch_count)" == 4 ]] && ok 'PI1a: on launches four panes' || bad "PI1a: $(launch_count)"
[[ "$(jq -r 'del(.workspace_id,.review_mode) | keys | join(",")' "$PJ")" \
  == 'design,design_review,exec,exec_review' ]] \
  && ok 'PI3a: prewarm.json has four role keys' || bad "PI3a: $(jq -c 'keys' "$PJ")"
jq -e 'has("executors") or has("review")' "$PJ" >/dev/null \
  && bad 'PI3b: legacy executors/review key remains' || ok 'PI3b: no legacy executors/review key'
for pair in 'design:t' 'design_review:t-design-review' 'exec:t-exec' 'exec_review:t-exec-review'; do
  r="${pair%%:*}"
  a="${pair##*:}"
  [[ "$(jq -r --arg r "$r" '.[$r].agent' "$PJ")" == "$a" ]] || bad "PI4: $r agent name"
done
ok 'PI4: four agent names'

grep -qE '^launch .*--role design_review .*--standby-split-direction right' "$TMP/calls.log" \
  && ok 'PI2a: design_review splits right' || bad 'PI2a'
grep -qE '^launch .*--role exec .*--standby-split-direction down' "$TMP/calls.log" \
  && ok 'PI2b: exec splits down' || bad 'PI2b'
grep -qE '^launch .*--role exec_review .*--standby-split-direction right' "$TMP/calls.log" \
  && ok 'PI2c: exec_review splits right' || bad 'PI2c'

run_pw "$ROLES_OFF" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
[[ "$(launch_count)" == 2 ]] && ok 'PI1b: off launches two panes' || bad "PI1b: $(launch_count)"
[[ "$(jq -r 'del(.workspace_id,.review_mode) | keys | join(",")' "$PJ")" == 'design,exec' ]] \
  && ok 'PI1c: off prewarm.json has two roles' || bad 'PI1c'

jq '.roles.exec = .roles.design' "$ROLES_OFF" > "$TMP/same.json"
run_pw "$TMP/same.json" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
{ [[ "$(launch_count)" == 2 ]] && jq -e 'has("exec")' "$PJ" >/dev/null; } \
  && ok 'PI5: identical tuples still launch exec' || bad 'PI5'

make_launch_stub exec_review
run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
if jq -e 'has("exec_review")' "$PJ" >/dev/null 2>&1; then
  bad 'PI6a: failed exec_review appears in prewarm.json'
else
  jq -e 'has("design_review") and has("design") and has("exec")' "$PJ" >/dev/null \
    && ok 'PI6a: omits only failed exec_review' || bad 'PI6a: another role disappeared'
fi
grep -q 'leave.sh .*-exec-review' "$TMP/calls.log" \
  && ok 'PI6b: failed exec_review leaves team' || bad 'PI6b'
[[ ! -e "$STATUS/review/code-review.json" ]] \
  && ok 'PI6c: prewarm does not create code-review.json' || bad 'PI6c'

make_launch_stub ""
run_pw "$ROLES_ON" >/dev/null 2>&1
PJ="$STATUS/prewarm.json"
{ [[ "$(jq -r '.design_review.agent' "$PJ")" == 't-design-review' ]] \
  && [[ "$(jq -r '.exec_review.agent' "$PJ")" == 't-exec-review' ]] \
  && [[ "$(jq -r '.design_review.model' "$PJ")" != "$(jq -r '.exec_review.model' "$PJ")" \
    || "$(jq -r '.design_review.runner' "$PJ")" != "$(jq -r '.exec_review.runner' "$PJ")" ]]; } \
  && ok 'PI6d: reviewer tuples remain distinct' \
  || bad "PI6d: $(jq -c '{dr:.design_review, xr:.exec_review}' "$PJ")"

exit $fail
