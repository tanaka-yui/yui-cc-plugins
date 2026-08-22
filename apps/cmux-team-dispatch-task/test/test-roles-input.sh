#!/usr/bin/env bash
# prewarm-panes.sh --roles input validation. Rejections must happen before cmux or agmsg calls.
# RI1 removed flags; RI2 valid on/off; RI3 tampering; RI4 trusted registry path;
# RI5 model matrix; RI6 no --review-mode option.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"

for f in --design-runner --reviewer-runner --exec-runner --claude-runner --codex-runner \
  --exec-choice --review-model --design-model --design-effort --reviewer-model \
  --reviewer-effort --exec-model --exec-effort --review-mode; do
  out=$(run_pw "$ROLES_ON" "$f" x)
  rc=$?
  [[ $rc -eq 2 || $rc -eq 1 ]] && grep -qi 'unknown\|removed' <<< "$out" \
    || bad "RI1: $f was not rejected"
done
ok 'RI1: rejects the 13 removed flags and --review-mode'

run_pw "$ROLES_ON" >/dev/null 2>&1
[[ "$(launch_count)" == 4 ]] && ok 'RI2a: review on launches four roles' \
  || bad "RI2a: launch count $(launch_count)"
run_pw "$ROLES_OFF" >/dev/null 2>&1
[[ "$(launch_count)" == 2 ]] && ok 'RI2b: review off launches two roles' \
  || bad "RI2b: launch count $(launch_count)"

. "$SCRIPT_DIR/lib/fifo-once.sh"
fifo_read_once 'RI2d: reads roles.json only once' "$ROLES_ON" run_pw_roles

out=$(bash "$PW" --with-design --cwd "$TMP/wt" --slug t --status-dir "$TMP/status" \
  --agmsg-team team 2>&1)
rc=$?
[[ $rc -eq 2 ]] && grep -q -- '--roles' <<< "$out" \
  && ok 'RI2c: missing --roles is an explicit exit 2' || bad "RI2c: rc=$rc $out"

# Valid JSON containers other than an object must take the validation path, not
# leak jq's internal exit status/error from the first object-only expression.
expect_non_object() { # $1=label $2=valid JSON document
  local label="$1" doc="$2" rc
  printf '%s\n' "$doc" > "$TMP/non-object.json"
  run_pw "$TMP/non-object.json" > "$TMP/non-object.out" 2>&1
  rc=$?
  if [[ $rc -eq 2 ]] \
    && grep -qi 'top-level.*object' "$TMP/non-object.out" \
    && no_side_effects; then
    ok "RI2e-$label: valid non-object JSON is an explicit side-effect-free validation error"
  else
    bad "RI2e-$label: rc=$rc output=$(cat "$TMP/non-object.out")"
  fi
}
expect_non_object number '42'
expect_non_object string '"roles"'
expect_non_object boolean 'true'
expect_non_object boolean-false 'false'
expect_non_object null 'null'
expect_non_object array '[]'

tamper_expr() { jq "$1" "$ROLES_ON" > "$TMP/bad.json"; run_pw "$TMP/bad.json" >/dev/null 2>&1; }
tamper_arg() { jq --arg v "$2" "$1" "$ROLES_ON" > "$TMP/bad.json"; run_pw "$TMP/bad.json" >/dev/null 2>&1; }

tamper_arg '.roles.design.model = $v' "a'; touch $TMP/pwn; #"
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3a: metacharacter model' || bad "RI3a (rc=$rc)"
tamper_arg '.roles.design.model = $v' 'bang!'
rc=$?; [[ $rc -eq 2 ]] && ok 'RI3a2: model containing !' || bad "RI3a2 (rc=$rc)"
tamper_expr '.roles.design.effort = "bogus"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3b: invalid effort' || bad "RI3b (rc=$rc)"
tamper_expr '.roles.design.engine = "codex"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3c: engine mismatch' || bad "RI3c (rc=$rc)"
tamper_expr '.roles.design.runner = "nope"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3d: unregistered runner' || bad "RI3d (rc=$rc)"
tamper_expr 'del(.roles.exec_review)'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3e: review role missing while on' || bad "RI3e (rc=$rc)"
tamper_expr '.review_mode = "off"'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3f: review roles present while off' || bad "RI3f (rc=$rc)"
tamper_expr '.roles.design.bogus = 1'
rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } && ok 'RI3g: disallowed key' || bad "RI3g (rc=$rc)"
[[ -e "$TMP/pwn" ]] && bad 'RI3h: test or implementation caused a side effect' || ok 'RI3h: no side effect'

cat > "$TMP/fake-runners.json" <<'JSON'
{"default":"evil","runners":[{"name":"evil","command":"evil","engine":"claude"}]}
JSON
jq --arg f "$TMP/fake-runners.json" '.runners_file = $f | .roles.design.runner = "evil"' \
  "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI4: ignores roles.json runners_file as a registry source' || bad 'RI4'

jq 'del(.roles.design_review.model)' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5a: rejects missing codex design_review model' || bad 'RI5a'
jq '.roles.design_review.model = null' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5b: rejects null codex design_review model' || bad 'RI5b'
for role in design_review exec_review; do
  for mut in 'del(.roles.ROLE.model)' '.roles.ROLE.model = null' '.roles.ROLE.model = ""'; do
    tamper_expr "${mut//ROLE/$role}"
    rc=$?; { [[ $rc -eq 2 ]] && no_side_effects; } \
      || bad "RI5-neg: accepted $role mutation $mut (rc=$rc)"
  done
done
ok 'RI5a: rejects omitted/null/empty model for both review roles'

for role in design exec; do
  jq --arg r "$role" '.roles[$r].runner = "cx" | .roles[$r].engine = "codex"
                      | del(.roles[$r].model)' "$ROLES_ON" > "$TMP/ok.json"
  run_pw "$TMP/ok.json" >/dev/null 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] \
    && ! grep -E "^launch .*--role $role( |\$)" "$TMP/calls.log" | grep -q -- '--model'; then
    ok "RI5c-$role: codex $role can omit model and launch omits --model"
  else
    bad "RI5c-$role: rc=$rc $(grep "^launch .*--role $role" "$TMP/calls.log")"
  fi
done
jq 'del(.roles.design.model)' "$ROLES_ON" > "$TMP/bad.json"
run_pw "$TMP/bad.json" >/dev/null 2>&1
[[ $? -eq 2 ]] && ok 'RI5d: rejects missing model for claude role' || bad 'RI5d'

grep -q -- '--review-mode' "$PW" && bad 'RI6: --review-mode remains in source' \
  || ok 'RI6: --review-mode does not exist'

exit $fail
