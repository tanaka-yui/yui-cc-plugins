#!/usr/bin/env bash
# 検証済みスナップショット契約の動的検査。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
fail=0
bad() { echo "FAIL $1"; fail=1; }
ok() { echo "PASS $1"; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export DISPATCH_CONFIG_HOME="$TMP/home"
mkdir -p "$DISPATCH_CONFIG_HOME" "$TMP/bin" "$TMP/status" "$TMP/dispatch/t"

. "$SCRIPT_DIR/lib/fifo-once.sh"
. "$SCRIPT_DIR/lib/prewarm-harness.sh"
. "$SCRIPT_DIR/lib/cleanup-harness.sh"
mkdir -p "$TMP/dispatch/t" "$TMP/status"
touch "$TMP/body.md"

cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON

VALID="$TMP/prewarm.json"
cat > "$VALID" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"s1","agent":"t","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "design_review":{"surface_id":"s2","agent":"t-design-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"xhigh","wired":true},
 "exec":{"surface_id":"s3","agent":"t-exec","runner":"ccf","engine":"claude","model":"sonnet","effort":"high","wired":true},
 "exec_review":{"surface_id":"s4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus[1m]","effort":"high","wired":true}}
JSON

render() {
  bash "$S/render-loop-prompt.sh" --prewarm "$1" --slug t --issue 1 --issue-title x \
    --issue-url u --issue-body-file "$TMP/body.md" --plan-hint h --status-dir "$TMP/status" \
    --timeout-sentinel "$TMP/sentinel" --team tm --layout workspace --parent-workspace w \
    --skill-dir "$S/.." 2> "$TMP/err"
}

# F7: codex の対話セッションでは --add-dir が seatbelt policy に届かないため、
# reviewer への追加許可は -c sandbox_workspace_write.writable_roots で与える。
if grep -Fq "REVIEW_WRITABLE_ROOTS+=\"'\$REVIEW_SANDBOX_DIR'\"" "$S/launch-workspace.sh" \
   && grep -q 'sandbox_workspace_write.writable_roots=\[' "$S/launch-workspace.sh" \
   && grep -q 'prepare_review_directory' "$S/launch-workspace.sh" \
   && ! grep -q "writable_roots.*\$STATUS_DIR" "$S/launch-workspace.sh" \
   && ! grep -Fq -- "--add-dir '" "$S/launch-workspace.sh"; then
  ok 'SC1: reviewer writable_roots uses the canonical validated review directory'
else
  bad 'SC1'
fi

fifo_read_once 'SC2a: renderer reads prewarm once' "$VALID" render
fifo_read_once 'SC2b: prewarm reads roles once' "$ROLES_ON" run_pw_roles
fifo_read_once 'SC2c: cleanup reads prewarm once' "$VALID" run_cleanup_with_prewarm

expect_reject() {
  local label="$1" expr="$2"
  if [[ $# -ge 3 ]]; then jq --arg v "$3" "$expr" "$VALID" > "$TMP/bad.json"
  else jq "$expr" "$VALID" > "$TMP/bad.json"; fi
  render "$TMP/bad.json" >/dev/null 2>&1
  local rc=$?
  if [[ $rc -ne 0 ]] && grep -qiE 'prewarm|invalid|agent|wired|surface' "$TMP/err"; then
    ok "$label"
  else
    bad "$label (rc=$rc err=$(cat "$TMP/err"))"
  fi
}
expect_reject 'SC3a: wrong role agent' '.design_review.agent = "t-exec"'
expect_reject 'SC3b: parent agent' '.design_review.agent = "parent"'
expect_reject 'SC4a: empty surface_id' '.design.surface_id = ""'
expect_reject 'SC4b: empty workspace_id' '.workspace_id = ""'
expect_reject 'SC5a: string wired' '.design.wired = "true"'
expect_reject 'SC5b: false wired' '.design.wired = false'
expect_reject 'SC5c: unknown role key' '.design.bogus = 1'
expect_reject 'SC5d: numeric effort' '.design.effort = 3'
expect_reject 'SC5e: shell metachar model' '.design.model = $v' "a'; touch $TMP/pwn; #"
expect_reject 'SC5g: active review model missing' 'del(.design_review.model)'
expect_reject 'SC5h: review_mode off rejects review roles' '.review_mode = "off"'
[[ -e "$TMP/pwn" ]] && bad 'SC5f: model caused side effect' || ok 'SC5f: no side effect'

expect_reject_cleanup() {
  local label="$1" expr="$2"
  if [[ $# -ge 3 ]]; then jq --arg v "$3" "$expr" "$VALID" > "$TMP/dispatch/t/prewarm.json"
  else jq "$expr" "$VALID" > "$TMP/dispatch/t/prewarm.json"; fi
  : > "$CLEANUP_HARNESS_CALLS"
  run_cleanup_for_slug t "$TMP/dispatch" >/dev/null 2>&1
  [[ "$(grep -c 'leave.sh\|close-surface' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true)" == 0 ]] \
    && ok "$label" || bad "$label ($(cat "$CLEANUP_HARNESS_CALLS"))"
}
cleanup_stub_workspace 'workspace:1'
expect_reject_cleanup 'SC8a: cleanup rejects wrong agent' '.design_review.agent = "t-exec"'
expect_reject_cleanup 'SC8b: cleanup rejects empty surface' '.design.surface_id = ""'
expect_reject_cleanup 'SC8c: cleanup rejects non-boolean wired' '.design.wired = "true"'
expect_reject_cleanup 'SC8d: cleanup rejects type mismatch' '.design.effort = 3'
expect_reject_cleanup 'SC8e: cleanup rejects unknown key' '.design.bogus = 1'
expect_reject_cleanup 'SC8f: cleanup rejects missing review model' 'del(.exec_review.model)'
expect_reject_cleanup 'SC8g: cleanup rejects review_mode off with review roles' '.review_mode = "off"'

cp "$VALID" "$TMP/dispatch/t/prewarm.json"
cleanup_stub_workspace 'workspace:1'
run_cleanup_for_slug t "$TMP/dispatch" >/dev/null; rc=$?
[[ $rc -eq 0 && "$(grep -c 'leave.sh' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true)" == 4 ]] \
  && ok 'SC6a: matching workspace leaves four roles' \
  || bad "SC6a: rc=$rc leaves=$(grep -c 'leave.sh' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true)"
cleanup_stub_workspace 'workspace:999'
run_cleanup_for_slug t "$TMP/dispatch" >/dev/null; rc=$?
[[ $rc -eq 0 && "$(grep -c 'leave.sh' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true)" == 0 ]] \
  && ok 'SC6b: mismatched workspace does not leave' \
  || bad "SC6b: rc=$rc leaves=$(grep -c 'leave.sh' "$CLEANUP_HARNESS_CALLS" 2>/dev/null || true)"

SC7_PAT='jq [^|<]*(prewarm\.json"|\$\{?(pj|PREWARM_FILE|PJ)\}?")'
if grep -nE "$SC7_PAT" "$SKILL" >/dev/null; then
  bad "SC7: SKILL.md directly jq-reads prewarm: $(grep -nE "$SC7_PAT" "$SKILL" | head -3)"
else
  ok 'SC7: SKILL.md follows snapshot contract'
fi
grep -q 'prune-not-ready.sh' "$SKILL" \
  && ok 'SC7b: SKILL delegates readiness pruning to the validated helper' || bad 'SC7b'

# Execute the normative task-prompt snippet itself. A source-grep for the function name
# cannot detect an undefined shell function, which previously stopped before role lookup.
mkdir -p "$TMP/prompt-status"
jq '.design.surface_id = "surface:1" |
    .design_review.surface_id = "surface:2" |
    .exec.surface_id = "surface:3" |
    .exec_review.surface_id = "surface:4"' "$VALID" > "$TMP/prompt-valid.json"
extract_prompt_snippet() {
  awk '
    /^    PREWARM_FILE=/ { in_snippet = 1 }
    in_snippet && /^prewarm\.json is mandatory/ { exit }
    in_snippet { sub(/^    /, ""); print }
  ' "$SKILL"
}
run_prompt_snippet() {
  local snapshot="$1" snippet
  cp "$snapshot" "$TMP/prompt-status/prewarm.json"
  snippet=$(extract_prompt_snippet)
  snippet=${snippet//<EXISTING_STATUS_DIR>/$TMP\/prompt-status}
  snippet=${snippet//<SKILL_DIR>/$S\/..}
  printf '%s\nprintf "role=%%s\\n" "$(role_value exec engine)"\n' "$snippet" > "$TMP/normative-prompt.sh"
  bash "$TMP/normative-prompt.sh" 2> "$TMP/normative-prompt.err"
}
prompt_out=$(run_prompt_snippet "$TMP/prompt-valid.json")
prompt_rc=$?
if [[ $prompt_rc -eq 0 && "$prompt_out" == 'role=claude' \
   && ! -s "$TMP/normative-prompt.err" ]]; then
  ok 'SC7c: normative SKILL prompt sources and executes the common validator before role lookup'
else
  bad "SC7c: normative prompt failed before role lookup (rc=$prompt_rc err=$(tr '\n' ' ' < "$TMP/normative-prompt.err"))"
fi

jq '.exec.wired = false' "$TMP/prompt-valid.json" > "$TMP/prompt-invalid.json"
prompt_out=$(run_prompt_snippet "$TMP/prompt-invalid.json")
prompt_rc=$?
if [[ $prompt_rc -ne 0 && "$prompt_out" != *'role='* ]] \
   && ! grep -Fq 'command not found' "$TMP/normative-prompt.err"; then
  ok 'SC7d: normative prompt rejects an invalid snapshot before role lookup'
else
  bad "SC7d: normative prompt did not execute real validation (rc=$prompt_rc out=$prompt_out err=$(tr '\n' ' ' < "$TMP/normative-prompt.err"))"
fi

exit "$fail"
