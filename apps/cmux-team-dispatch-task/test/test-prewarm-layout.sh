#!/usr/bin/env bash
# prewarm-panes.sh fixed layout, readiness wiring, and fail-fast guards.
# PG1 on=2x2; PG2 off=2 panes; PG3 role tuples drive each launch.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
pass() { echo "PASS: $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }
. "$SCRIPT_DIR/lib/prewarm-harness.sh"

# Replace the shared harness stubs with ordered/failable variants.
cat > "$FAKE/launch-workspace.sh" <<'STUB'
#!/usr/bin/env bash
printf 'launch %s\n' "$*" >> "$CALLS_LOG"
[[ -n "${ORDER_LOG:-}" ]] && printf 'launch %s\n' "$*" >> "$ORDER_LOG"
count=$(grep -c '^launch ' "$CALLS_LOG" || true)
case "$*" in *"--role ${FAIL_LAUNCH_ROLE:-__none__} "*) exit 1 ;; esac
jq -n --arg surface "surface:$count" '{workspace_id:"workspace:1",surface_id:$surface}'
STUB
chmod +x "$FAKE/launch-workspace.sh"

for b in join.sh delivery.sh leave.sh send.sh; do
  cat > "$TMP/bin/$b" <<'STUB'
#!/usr/bin/env bash
name=$(basename "$0")
printf '%s %s\n' "$name" "$*" >> "$CALLS_LOG"
[[ -n "${ORDER_LOG:-}" ]] && printf '%s %s\n' "$name" "$*" >> "$ORDER_LOG"
[[ "$name" == delivery.sh && -n "${FAIL_DELIVERY:-}" ]] && exit 1
[[ "$name" == join.sh && -n "${FAIL_JOIN_AGENT:-}" && "$2" == "$FAIL_JOIN_AGENT" ]] && exit 1
exit 0
STUB
  chmod +x "$TMP/bin/$b"
done

run_layout() {
  local roles="$1" slug="$2"
  STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
  : > "$TMP/calls.log"
  CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug "$slug" \
    --status-dir "$STATUS" --agmsg-team team --roles "$roles" >/dev/null 2>&1
}
launch_line() { grep '^launch ' "$TMP/calls.log" | grep -F -- "--role $1 " || true; }

run_layout "$ROLES_ON" pg1
[[ "$(launch_count)" == 4 ]] && pass 'PG1 review on launches four panes' || bad 'PG1 pane count'
grep -Fq -- '--role design_review --standby-in workspace:1 --standby-split-from surface:1 --standby-split-direction right' <<< "$(launch_line design_review)" \
  && pass 'PG1 design_review splits right from design' || bad 'PG1 design_review split'
grep -Fq -- '--role exec --standby-in workspace:1 --standby-split-from surface:1 --standby-split-direction down' <<< "$(launch_line exec)" \
  && pass 'PG1 exec splits down from design' || bad 'PG1 exec split'
grep -Fq -- '--role exec_review --standby-in workspace:1 --standby-split-from surface:3 --standby-split-direction right' <<< "$(launch_line exec_review)" \
  && pass 'PG1 exec_review splits right from exec' || bad 'PG1 exec_review split'

run_layout "$ROLES_OFF" pg2
[[ "$(launch_count)" == 2 ]] && pass 'PG2 review off launches two panes' || bad 'PG2 pane count'
jq -e 'keys == ["design","exec","review_mode","workspace_id"]' "$STATUS/prewarm.json" >/dev/null \
  && pass 'PG2 review off schema has design and exec only' || bad 'PG2 schema'

run_layout "$ROLES_ON" pg3
for spec in 'design ccf claude xhigh' 'design_review cx codex xhigh' 'exec cx codex high' 'exec_review ccf claude high'; do
  set -- $spec
  line=$(launch_line "$1")
  [[ "$line" == *"--runner $2"* && "$line" == *"--effort $4"* ]] \
    && pass "PG3 $1 uses resolved runner/effort" || bad "PG3 $1 tuple"
done
jq -e '[.design,.design_review,.exec,.exec_review] | all(.wired == true) and
  ([.[] | has("delivery") or has("watcher")] | any | not)' "$STATUS/prewarm.json" >/dev/null \
  && pass 'PW1 all role entries are wired without legacy diagnostics' || bad 'PW1 wired schema'
grep -Fq -- '[ready] pg3 with no trailing period' <<< "$(launch_line design)" \
  && grep -Fq -- 'AGMSG-DIRECTIVE' <<< "$(launch_line design)" \
  && pass 'PW3 claude design carries readiness clause' || bad 'PW3 claude readiness'
grep -Fq -- 'codex-record-session.sh' <<< "$(launch_line exec)" \
  && grep -Fq -- '[ready] pg3-exec with no trailing period' <<< "$(launch_line exec)" \
  && pass 'PW4 codex exec carries seat/readiness clause' || bad 'PW4 codex readiness'

# Wiring failure must happen before the first launch and prewarm artifact.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
FAIL_DELIVERY=1 CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw2 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1
rc=$?
[[ $rc -ne 0 && "$(launch_count)" == 0 && ! -e "$STATUS/prewarm.json" ]] \
  && pass 'PW2 delivery failure is side-effect-free with respect to panes/artifact' || bad 'PW2 fail-fast'

# Missing team is rejected before worktree/agmsg/pane effects.
: > "$TMP/calls.log"
missing="$TMP/missing-worktree"
out=$(CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$missing" --slug pw8 \
  --status-dir "$TMP/status-pw8" --roles "$ROLES_ON" 2>&1)
rc=$?
[[ $rc -ne 0 && "$out" == *'--agmsg-team is required'* && ! -d "$missing" && ! -s "$TMP/calls.log" ]] \
  && pass 'PW8 missing agmsg team rejects before side effects' || bad 'PW8 fail-fast'

# Design join failure is fatal before any launch.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
FAIL_JOIN_AGENT=pw9 CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw9 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1
rc=$?
[[ $rc -ne 0 && "$(launch_count)" == 0 && ! -e "$STATUS/prewarm.json" ]] \
  && pass 'PW9 design join failure is fatal before launch' || bad 'PW9 fail-fast'

# Every delivery setup precedes the first launch.
: > "$TMP/order.log"
ORDER_LOG="$TMP/order.log" run_layout "$ROLES_ON" pw10
first_launch=$(grep -n '^launch ' "$TMP/order.log" | head -1 | cut -d: -f1)
last_delivery=$(grep -n '^delivery.sh ' "$TMP/order.log" | tail -1 | cut -d: -f1)
[[ -n "$first_launch" && -n "$last_delivery" && $last_delivery -lt $first_launch ]] \
  && pass 'PW10 all delivery wiring finishes before launch' || bad 'PW10 wiring order'

# Required launch failures roll back only resources owned by this invocation.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
FAIL_LAUNCH_ROLE=design CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw11 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1
rc=$?
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
closes=$(grep -c '^cmux close-surface ' "$TMP/calls.log" 2>/dev/null || true)
[[ $rc -ne 0 && "$leaves" == 4 && "$closes" == 0 && -d "$TMP/wt" && ! -e "$STATUS/prewarm.json" ]] \
  && pass 'PW11 design launch failure leaves joined roles and preserves reused worktree' \
  || bad "PW11 rollback (rc=$rc leaves=$leaves closes=$closes)"

STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
FAIL_LAUNCH_ROLE=exec CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw12 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1
rc=$?
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
closes=$(grep -c '^cmux close-surface ' "$TMP/calls.log" 2>/dev/null || true)
if [[ $rc -ne 0 && "$leaves" == 4 && "$closes" == 2 && ! -e "$STATUS/prewarm.json" ]] \
  && grep -Fq 'surface:1' "$TMP/calls.log" && grep -Fq 'surface:2' "$TMP/calls.log"; then
  pass 'PW12 exec launch failure closes only panes launched by this invocation'
else
  bad "PW12 rollback (rc=$rc leaves=$leaves closes=$closes)"
fi

# The production caller does not export CMUX_BIN. A required launch failure after earlier
# panes were created must still run the rest of rollback instead of aborting on set -u.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
FAIL_LAUNCH_ROLE=exec CALLS_LOG="$TMP/calls.log" env -u CMUX_BIN \
  bash "$PW" --with-design --cwd "$TMP/wt" --slug pw14 \
    --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" \
    >/dev/null 2>"$TMP/pw14.err"
rc=$?
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
if [[ $rc -ne 0 && "$leaves" == 4 && ! -e "$STATUS/prewarm.json" ]] \
  && ! grep -Fq 'CMUX_BIN: unbound variable' "$TMP/pw14.err"; then
  pass 'PW14 unset CMUX_BIN still completes required-failure rollback'
else
  bad "PW14 unset CMUX_BIN rollback (rc=$rc leaves=$leaves err=$(tr '\n' ' ' < "$TMP/pw14.err"))"
fi

# A missing worktree is owned by this invocation and must be removed together with a newly
# created branch. The git stub confines every effect and records exact targets.
mkdir -p "$TMP/git-bin"
cat > "$TMP/git-bin/git" <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$GIT_CALLS"
case "$1 $2" in
  'show-ref --verify') exit 1 ;;
  'worktree add')
    for arg in "$@"; do case "$arg" in /*) mkdir -p "$arg"; break ;; esac; done
    exit 0 ;;
  'worktree remove')
    for arg in "$@"; do case "$arg" in /*) rm -rf "$arg"; break ;; esac; done
    exit 0 ;;
  'branch -D') exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/git-bin/git"
created_wt="$TMP/created-wt"
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"; : > "$TMP/git.calls"
FAIL_LAUNCH_ROLE=design CALLS_LOG="$TMP/calls.log" GIT_CALLS="$TMP/git.calls" \
  PATH="$TMP/git-bin:$PATH" bash "$PW" --with-design --cwd "$created_wt" --slug pw13 \
    --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>&1
rc=$?
if [[ $rc -ne 0 && ! -e "$created_wt" ]] \
  && grep -Fq "worktree remove $created_wt --force" "$TMP/git.calls" \
  && grep -Fq 'branch -D feat/pw13' "$TMP/git.calls"; then
  pass 'PW13 failure removes only the worktree and branch created by this invocation'
else
  bad "PW13 created worktree rollback (rc=$rc exists=$([[ -e "$created_wt" ]] && echo yes || echo no))"
fi

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
