#!/usr/bin/env bash
# --override の 4 ロール契約を検証する。
#  OV10. 対象ロールは design / design_review / exec / exec_review
#  OV11. review 2 ロールは review_mode=on のときだけ提示する
#  OV12. 4 ロール x 3 次元の override は適用され、config は不変
#  OV13. override 無しで再 resolve すると永続値へ戻る
#  OV14. pending tuple の不正次元はロール単位で破棄され、他ロールは生き残る
#  OV15. prewarm には --roles だけを渡し、旧ロール別フラグを渡さない

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/../skills/cmux-team-dispatch-task"
SKILL_MD="$SKILL_DIR/SKILL.md"
RESOLVE="$SKILL_DIR/scripts/config-resolve.sh"
OVERRIDE_ARGS_SH="$SKILL_DIR/scripts/override-args.sh"

fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
PROJ="$TMP/repo"
GLOBAL_CONFIG="$DISPATCH_CONFIG_HOME/config.json"
RUNNERS_JSON="$DISPATCH_CONFIG_HOME/runners.json"
PROJ_CONFIG="$PROJ/.dispatch/config.json"
mkdir -p "$DISPATCH_CONFIG_HOME" "$PROJ/.dispatch"

cat > "$RUNNERS_JSON" <<'JSON'
{"default":"ccf","runners":[
  {"name":"ccf","command":"ccf","engine":"claude"},
  {"name":"cx","command":"codex","engine":"codex"}
]}
JSON
cat > "$GLOBAL_CONFIG" <<'JSON'
{"review_mode":"on","runner":{
  "design":{"runner":"ccf"},"design_review":{"runner":"ccf"},
  "exec":{"runner":"ccf"},"exec_review":{"runner":"ccf"}}}
JSON
cat > "$PROJ_CONFIG" <<'JSON'
{"unrelated":"preserved"}
JSON

OVERRIDE_SECTION=$(sed -n '/^### 1g-2\./,/^### 1h\./p' "$SKILL_MD")
all_roles=1
for role in design design_review exec exec_review; do
  grep -Fq -- "$role" <<< "$OVERRIDE_SECTION" || { bad "OV10: $role が override 対象に無い"; all_roles=0; }
done
[[ $all_roles -eq 1 ]] && ok 'OV10: override 対象は 4 ロール'
grep -Fq -- 'review_mode=on' <<< "$OVERRIDE_SECTION" \
  && ok 'OV11: review 2 ロールは review_mode=on のときだけ提示する' \
  || bad 'OV11: review 2 ロールの提示条件が無い'

if grep -Fq 'done < <(' <<< "$OVERRIDE_SECTION"; then
  bad 'OV11b: override builder status is hidden by process substitution'
elif grep -Fq 'OVERRIDE_BUILDER_RC=$?' <<< "$OVERRIDE_SECTION" \
  && grep -Fq 'OVERRIDE_OUTPUT' <<< "$OVERRIDE_SECTION"; then
  ok 'OV11b: override builder output and non-zero status are captured explicitly'
else
  bad 'OV11b: explicit override builder status capture is missing'
fi

ARGS=()
for role in design design_review exec exec_review; do
  ARGS+=(--set "$role.runner=cx" --set "$role.model=M-$role" --set "$role.effort=medium")
done
g_before=$(shasum -a 256 "$GLOBAL_CONFIG" | cut -d' ' -f1)
p_before=$(shasum -a 256 "$PROJ_CONFIG" | cut -d' ' -f1)
out=$(bash "$RESOLVE" --project-root "$PROJ" "${ARGS[@]}")

applied=1
for role in design design_review exec exec_review; do
  [[ "$(jq -r --arg r "$role" '.roles[$r].runner' <<< "$out")" == cx ]] || applied=0
  [[ "$(jq -r --arg r "$role" '.roles[$r].model' <<< "$out")" == "M-$role" ]] || applied=0
  [[ "$(jq -r --arg r "$role" '.roles[$r].effort' <<< "$out")" == medium ]] || applied=0
  [[ "$(jq -r --arg r "$role" '.roles[$r].engine' <<< "$out")" == codex ]] || applied=0
done
[[ $applied -eq 1 ]] \
  && ok 'OV12a: 4 ロール x 3 次元の override が適用され engine も追随する' \
  || bad "OV12a: $(jq -c '.roles' <<< "$out")"

[[ "$(shasum -a 256 "$GLOBAL_CONFIG" | cut -d' ' -f1)" == "$g_before" \
  && "$(shasum -a 256 "$PROJ_CONFIG" | cut -d' ' -f1)" == "$p_before" ]] \
  && ok 'OV12b: override は両 config を 1 バイトも変えない' || bad 'OV12b'

out2=$(bash "$RESOLVE" --project-root "$PROJ")
[[ "$(jq -r '.roles.design.model' <<< "$out2")" == 'opus[1m]' \
  && "$(jq -r '.roles.design.runner' <<< "$out2")" == ccf ]] \
  && ok 'OV13: 次回の resolve は元の値へ戻る' \
  || bad "OV13: $(jq -c '.roles.design' <<< "$out2")"

ROLES_JSON="$TMP/roles.json"
printf '%s\n' "$out2" > "$ROLES_JSON"
build_args() {
  ARGS=()
  while IFS= read -r -d '' arg; do ARGS+=("$arg"); done < <(
    bash "$OVERRIDE_ARGS_SH" --roles "$ROLES_JSON" --runners "$RUNNERS_JSON" "$@" 2>/dev/null
  )
}

assert_role_drop() {
  local label="$1"; shift
  build_args --pending design.model=KEPT "$@"
  local resolved
  resolved=$(bash "$RESOLVE" --project-root "$PROJ" "${ARGS[@]}")
  if [[ "$(jq -r '.roles.design.model' <<< "$resolved")" == KEPT \
    && "$(jq -r '.roles.exec.runner' <<< "$resolved")" == ccf \
    && "$(jq -r '.roles.exec.model' <<< "$resolved")" == sonnet \
    && "$(jq -r '.roles.exec.effort' <<< "$resolved")" == high ]]; then
    ok "OV14-$label: exec 全体を破棄し design の override は維持"
  else
    bad "OV14-$label: $(jq -c '.roles | {design,exec}' <<< "$resolved")"
  fi
}
assert_role_drop model --pending exec.runner=cx --pending 'exec.model=opus[1m]' --pending exec.effort=medium
assert_role_drop effort --pending exec.runner=cx --pending exec.model=gpt-5.6-terra --pending exec.effort=max
assert_role_drop runner --pending exec.runner=missing --pending exec.model=gpt-5.6-terra --pending exec.effort=medium

PREWARM_SECTION=$(sed -n '/^### Pre-warm Standby Panes/,/^## /p' "$SKILL_MD")
grep -Fq -- '--roles "$ROLES_JSON"' <<< "$PREWARM_SECTION" \
  && ok 'OV15a: prewarm へ --roles を渡す' || bad 'OV15a: prewarm の --roles が無い'
if grep -nE -- '--design-model|--design-effort|--reviewer-model|--reviewer-effort|--exec-model|--exec-effort' "$SKILL_MD"; then
  bad 'OV15b: 旧 override フラグが SKILL.md に残っている'
else
  ok 'OV15b: prewarm への引渡しは --roles 1 本'
fi

exit "$fail"
