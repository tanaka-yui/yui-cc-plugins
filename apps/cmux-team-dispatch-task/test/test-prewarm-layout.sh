#!/usr/bin/env bash
# prewarm-panes.sh fixed layout, readiness wiring, and fail-fast guards.
# PG1 on=2x2; PG2 off=2 panes; PG3 role tuples drive each launch.
#
# PG1 は分割の方向と分割元だけでなく **順序** も固定する。`cmux new-split` はサイズ引数を
# 取らず対象ペインを 50/50 に割るだけなので、均等な 2x2 になるかどうかは順序だけで決まる。
# design_review を exec より先に作ると design が先に左半分へ縮み、design_review が右半分を
# 全高で占めてしまう。その後 design を down 分割しても割れるのは左半分だけなので、
# 左に 3 枚・右に 1 枚（全高）という不均等なレイアウトになる。方向と分割元は 1 つずつ見れば
# どれも正しいままなので、順序を検査しない限りこの崩れはテストを通過する。

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
case "$*" in
  *"--role ${INVALID_JSON_ROLE:-__none__} "*) printf '%s\n' 'not-json'; exit 0 ;;
esac
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
# 1) design (全面) → 2) exec を down (上下 2 段、どちらも全幅) →
# 3) design_review を design から right (上段を左右へ) →
# 4) exec_review を exec から right (下段を左右へ)。これで 4 象限が均等になる。
grep -Fq -- '--role exec --standby-in workspace:1 --standby-split-from surface:1 --standby-split-direction down' <<< "$(launch_line exec)" \
  && pass 'PG1 exec splits down from design' || bad 'PG1 exec split'
grep -Fq -- '--role design_review --standby-in workspace:1 --standby-split-from surface:1 --standby-split-direction right' <<< "$(launch_line design_review)" \
  && pass 'PG1 design_review splits right from design' || bad 'PG1 design_review split'
grep -Fq -- '--role exec_review --standby-in workspace:1 --standby-split-from surface:2 --standby-split-direction right' <<< "$(launch_line exec_review)" \
  && pass 'PG1 exec_review splits right from exec' || bad 'PG1 exec_review split'

# 均等な 2x2 を決めているのは順序である。exec は design_review より先でなければならない。
LAUNCH_ORDER=$(grep '^launch ' "$TMP/calls.log" \
  | sed -n 's/.*--role \([a-z_]*\) .*/\1/p' | tr '\n' ' ')
[[ "$LAUNCH_ORDER" == "design exec design_review exec_review " ]] \
  && pass 'PG1 分割順序が design → exec → design_review → exec_review である' \
  || bad "PG1 分割順序が不均等な 2x2 を生む: [$LAUNCH_ORDER]"

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
# exec は design の直後に立てるので、この時点で存在するペインは design の 1 枚だけである
# (均等な 2x2 のための順序変更による。以前は design_review が先だったので 2 枚だった)。
# 必須ロールの失敗はこの 2 地点しか無く、design での失敗は 0 枚なので、
# 「このプロセスが作ったものだけを閉じる」不変条件はここが最大ケースになる。
if [[ $rc -ne 0 && "$leaves" == 4 && "$closes" == 1 && ! -e "$STATUS/prewarm.json" ]] \
  && grep -Fq 'surface:1' "$TMP/calls.log"; then
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

# An existing non-directory status path is rejected before any owned resources are created.
STATUS="$TMP/status-publish-file"
: > "$STATUS"
: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw15 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" \
  >/dev/null 2>"$TMP/pw15.err"
rc=$?
launches=$(launch_count)
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
closes=$(grep -c '^cmux close-surface ' "$TMP/calls.log" 2>/dev/null || true)
if [[ $rc -ne 0 && "$launches" == 0 && "$leaves" == 0 && "$closes" == 0 \
   && ! -e "$STATUS/prewarm.json" ]]; then
  pass 'PW15 invalid status root is rejected before resource creation'
else
  bad "PW15 status root guard (rc=$rc launches=$launches leaves=$leaves closes=$closes)"
fi

# The producer owns the status trust boundary. A symlink status root must not let
# either JSON artifact escape the dispatch directory.
outside_status="$TMP/outside-status"
mkdir -p "$outside_status"
STATUS="$TMP/status-root-link"
ln -s "$outside_status" "$STATUS"
: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw16 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_OFF" \
  >/dev/null 2>"$TMP/pw16.err"
rc=$?
if [[ $rc -ne 0 && "$(launch_count)" == 0 \
   && ! -e "$outside_status/prewarm.json" && ! -e "$outside_status/status.json" ]]; then
  pass 'PW16 symlink status root is rejected before launch or external writes'
else
  bad "PW16 status root trust boundary (rc=$rc launches=$(launch_count))"
fi

# Existing artifact leaves may be replaced only when they are regular non-symlink
# files. In particular, redirection must never follow an external-file symlink.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
outside_prewarm="$TMP/outside-prewarm.json"
printf '%s\n' 'outside sentinel' > "$outside_prewarm"
ln -s "$outside_prewarm" "$STATUS/prewarm.json"
: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw17 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_OFF" \
  >/dev/null 2>"$TMP/pw17.err"
rc=$?
outside_content=$(cat "$outside_prewarm")
if [[ $rc -ne 0 && "$(launch_count)" == 0 && "$outside_content" == 'outside sentinel' \
   && -L "$STATUS/prewarm.json" ]]; then
  pass 'PW17 symlink prewarm leaf is rejected without overwriting its target'
else
  bad "PW17 prewarm leaf trust boundary (rc=$rc launches=$(launch_count) outside=$outside_content)"
fi

# A launcher may exit zero while violating its JSON stdout contract. The producer must
# route that parse failure through the same required-role rollback as a non-zero launch.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
INVALID_JSON_ROLE=exec CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design \
  --cwd "$TMP/wt" --slug pw18 --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" \
  >/dev/null 2>"$TMP/pw18.err"
rc=$?
launches=$(launch_count)
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
closes=$(grep -c '^cmux close-surface ' "$TMP/calls.log" 2>/dev/null || true)
# launches=2 / closes=1 は PW12 と同じ理由 (exec は design の直後)。
if [[ $rc -ne 0 && "$launches" == 2 && "$leaves" == 4 && "$closes" == 1 \
   && ! -e "$STATUS/prewarm.json" ]]; then
  pass 'PW18 invalid successful launcher JSON triggers required-role rollback'
else
  bad "PW18 invalid launcher JSON rollback (rc=$rc launches=$launches leaves=$leaves closes=$closes)"
fi

# A directory at the initial-status leaf is invalid before launch. It must not allow a
# prewarm artifact to be committed first and left behind after status publication fails.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
mkdir "$STATUS/status.json"
: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw19 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" \
  >/dev/null 2>"$TMP/pw19.err"
rc=$?
if [[ $rc -ne 0 && "$(launch_count)" == 0 && ! -e "$STATUS/prewarm.json" ]]; then
  pass 'PW19 directory status leaf is rejected before launch or partial publication'
else
  bad "PW19 status directory leaf (rc=$rc launches=$(launch_count) prewarm=$([[ -e "$STATUS/prewarm.json" ]] && echo yes || echo no))"
fi

# The initial-status leaf has the same non-symlink rule as prewarm.json.
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
outside_initial_status="$TMP/outside-status.json"
printf '%s\n' 'outside status sentinel' > "$outside_initial_status"
ln -s "$outside_initial_status" "$STATUS/status.json"
: > "$TMP/calls.log"
CALLS_LOG="$TMP/calls.log" bash "$PW" --with-design --cwd "$TMP/wt" --slug pw20 \
  --status-dir "$STATUS" --agmsg-team team --roles "$ROLES_ON" \
  >/dev/null 2>"$TMP/pw20.err"
rc=$?
outside_status_content=$(cat "$outside_initial_status")
if [[ $rc -ne 0 && "$(launch_count)" == 0 && ! -e "$STATUS/prewarm.json" \
   && "$outside_status_content" == 'outside status sentinel' ]]; then
  pass 'PW20 symlink status leaf is rejected without overwriting its target'
else
  bad "PW20 status symlink leaf (rc=$rc launches=$(launch_count) outside=$outside_status_content)"
fi

# Inject a genuine late failure at the atomic status rename. Both JSON documents must be
# staged before commit, so no prewarm artifact is visible and all owned resources roll back.
mkdir -p "$TMP/publish-bin"
REAL_MV=$(command -v mv)
cat > "$TMP/publish-bin/mv" <<'STUB'
#!/usr/bin/env bash
last=''
for arg in "$@"; do last="$arg"; done
[[ "$last" == */status.json ]] && exit 1
exec "$REAL_MV" "$@"
STUB
chmod +x "$TMP/publish-bin/mv"
STATUS=$(mktemp -d "$TMP/status-layout.XXXXXX")
: > "$TMP/calls.log"
REAL_MV="$REAL_MV" PATH="$TMP/publish-bin:$PATH" CALLS_LOG="$TMP/calls.log" \
  bash "$PW" --with-design --cwd "$TMP/wt" --slug pw21 --status-dir "$STATUS" \
    --agmsg-team team --roles "$ROLES_ON" >/dev/null 2>"$TMP/pw21.err"
rc=$?
launches=$(launch_count)
leaves=$(grep -c '^leave.sh ' "$TMP/calls.log" 2>/dev/null || true)
closes=$(grep -c '^cmux close-surface ' "$TMP/calls.log" 2>/dev/null || true)
if [[ $rc -ne 0 && "$launches" == 4 && "$leaves" == 4 && "$closes" == 4 \
   && ! -e "$STATUS/prewarm.json" && ! -e "$STATUS/status.json" ]]; then
  pass 'PW21 late status rename failure leaves no partial artifacts and rolls back resources'
else
  bad "PW21 late status failure (rc=$rc launches=$launches leaves=$leaves closes=$closes)"
fi

# PW-W1: .wiring は最初のペイン起動より前に作られ、prewarm.json の publish 後に消える。
# 起動より前であることは、cmux スタブが呼ばれた時点の sentinel 有無で見る。
# (実装は「引数検証の直後・launch_role の前」に touch を置くこと)
run_pw "$ROLES_ON" >/dev/null 2>&1
if [[ -f "$STATUS/prewarm.json" && ! -e "$STATUS/.wiring" ]]; then
  pass "PW-W1a: 正常終了後は prewarm.json があり .wiring は残らない"
else
  bad "PW-W1a: prewarm=$([[ -f $STATUS/prewarm.json ]] && echo yes || echo no) wiring=$([[ -e $STATUS/.wiring ]] && echo yes || echo no)"
fi

# PW-W1b: design ペインの起動に失敗した経路でも sentinel を残さない。
# 残すと completion-gate が「配線中」と読み続け、壊れた prewarm を永久に見逃す。
make_launch_stub design
run_pw "$ROLES_ON" >/dev/null 2>&1
[[ ! -e "$STATUS/.wiring" ]] \
  && pass "PW-W1b: die 経路でも .wiring を残さない" \
  || bad "PW-W1b: .wiring が残っている"
make_launch_stub ''

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
