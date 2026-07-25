#!/usr/bin/env bash
# issue-fetch.sh のロック・状態遷移・取得クエリの検査。gh はスタブ化する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/issue-fetch.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo"
STATE="$TMP/repo/.dispatch-loop/loop-state.json"
export PATH="$TMP/bin:$PATH"

fail=0
ok() { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; fail=1; }
check() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }
run() { LOOP_SESSION_ID="${SID:-sess-a}" bash "$FETCH" --state-file "$STATE" "$@"; }
limit_not_over_1000() {
  awk '{ for (i = 1; i <= NF; i++) if ($i == "--limit" && $(i + 1) > 1000) bad = 1 } END { exit bad }' "$GH_LOG"
}

# L0: fresh lock-check is read-only.
check 'SID=sess-a run lock-check' 'L0 .dispatch-loop 不在でも lock-check が成功する'
check '[[ ! -d "$TMP/repo/.dispatch-loop" ]]' 'L0 lock-check は read-only (ディレクトリを作らない)'

# L1-L5: acquisition, contention, and ownership-aware release.
check 'SID=sess-a run lock-acquire --lease-min 30' 'L1 初回 lock-acquire が成功する'
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L1 ロックディレクトリが作られる'
check '! SID=sess-b run lock-acquire --lease-min 30' 'L2 別 owner の lock-acquire は失敗する'
SID=sess-b run lock-release >/dev/null 2>&1 || true
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L3 別 owner の lock-release はロックを消さない'
check '! SID=sess-b run lock-check' 'L4 lock-check は active loop を検出して非 0'
check 'SID=sess-a run lock-release' 'L5 owner 一致の lock-release は成功する'
check '[[ ! -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L5 ロックディレクトリが消える'

# L6-L8: stale takeover and in-flight lock protection.
SID=sess-a run lock-acquire --lease-min 30
OWNER="$TMP/repo/.dispatch-loop/loop.lock.d/owner.json"
jq '.heartbeat = "2000-01-01T00:00:00Z"' "$OWNER" > "$OWNER.tmp" && mv "$OWNER.tmp" "$OWNER"
check 'SID=sess-c run lock-acquire --lease-min 30' 'L6 stale なロックは takeover できる'
check '[[ $(ls -d "$TMP/repo/.dispatch-loop"/loop.lock.stale.* | wc -l) -eq 1 ]]' 'L6 旧ロックは 1 つだけ退避される'
check '! SID=sess-a run heartbeat' 'L7 owner 不一致の heartbeat は exit 1'
SID=sess-c run lock-release
mkdir "$TMP/repo/.dispatch-loop/loop.lock.d"
check '! SID=sess-x run lock-acquire --lease-min 30' 'L8 owner.json 未生成のロックは奪わない'
check '! SID=sess-x run lock-release' 'L8 owner.json 未生成のロックは release しない'
check '[[ -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L8 ロックが残っている'
rm -rf "$TMP/repo/.dispatch-loop/loop.lock.d"

# L9-L10: parallel acquisition and stale takeover remain single-owner.
BAR="$TMP/barrier"
for s in p1 p2 p3 p4; do
  (while [[ ! -f "$BAR" ]]; do sleep 0.05; done
   LOOP_SESSION_ID="$s" bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null 2>&1 && echo "$s" >> "$TMP/winners.txt") &
done
sleep 0.2; : > "$BAR"; wait
check '[[ $(wc -l < "$TMP/winners.txt" | tr -d " ") -eq 1 ]]' 'L9 同時取得の勝者は 1 つだけ'
WINNER=$(cat "$TMP/winners.txt")
check '[[ $(jq -r ".session_id" "$TMP/repo/.dispatch-loop/loop.lock.d/owner.json") == "$WINNER" ]]' 'L9 owner.json が勝者と一致する'
LOOP_SESSION_ID="$WINNER" bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1

SID=sess-a run lock-acquire --lease-min 30 >/dev/null
OWNER="$TMP/repo/.dispatch-loop/loop.lock.d/owner.json"
jq '.heartbeat = "2000-01-01T00:00:00Z"' "$OWNER" > "$OWNER.tmp" && mv "$OWNER.tmp" "$OWNER"
rm -f "$TMP/winners.txt" "$BAR"
for s in t1 t2 t3; do
  (while [[ ! -f "$BAR" ]]; do sleep 0.05; done
   LOOP_SESSION_ID="$s" bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30 >/dev/null 2>&1 && echo "$s" >> "$TMP/winners.txt") &
done
sleep 0.2; : > "$BAR"; wait
check '[[ $(wc -l < "$TMP/winners.txt" | tr -d " ") -eq 1 ]]' 'L10 同時 stale takeover の勝者も 1 つ'
WINNER=$(cat "$TMP/winners.txt")
check '[[ ! -d "$TMP/repo/.dispatch-loop/loop.lock.takeover.d" ]]' 'L10 takeover mutex が解放されている'
LOOP_SESSION_ID="$WINNER" bash "$FETCH" --state-file "$STATE" lock-release >/dev/null 2>&1

# L11: read-only lock check does not require an owner identity.
set +e
(unset LOOP_SESSION_ID CLAUDE_CODE_SESSION_ID; bash "$FETCH" --state-file "$STATE" lock-check) >/dev/null 2>&1; rc_check=$?
(unset LOOP_SESSION_ID CLAUDE_CODE_SESSION_ID; bash "$FETCH" --state-file "$STATE" lock-acquire --lease-min 30) >/dev/null 2>&1; rc_acq=$?
set -e
check '[[ $rc_check -eq 0 ]]' 'L11 session id 無しでも lock-check は成功する'
check '[[ ! -d "$TMP/repo/.dispatch-loop/loop.lock.d" ]]' 'L11 lock-check は何も作らない'
check '[[ $rc_acq -ne 0 ]]' 'L11 session id 無しの lock-acquire は拒否される'

# L12: init uses the complete schema and preserves records when reconfigured.
SID=sess-c run lock-acquire --lease-min 30 >/dev/null
SID=sess-c run init --config-json '{"concurrency":2,"max_batches":3,"integration":"pr","task_timeout_min":90,"lock_lease_min":30}' --filter-json '{"labels":["enhancement"],"assignee":"@me","state":"open"}'
check '[[ -f "$STATE" ]]' 'L12 init が loop-state.json を作る'
check '[[ $(jq -r ".config.concurrency" "$STATE") == "2" ]]' 'L12 config を記録する'
check '[[ $(jq -r ".filter.assignee" "$STATE") == "@me" ]]' 'L12 filter を記録する'
check '[[ $(jq -r ".issues | length" "$STATE") == "0" ]]' 'L12 issues を初期化する'
jq '.issues["99"] = {slug:"keep", status:"done", batch:1}' "$STATE" > "$STATE.t" && mv "$STATE.t" "$STATE"
SID=sess-c run init --config-json '{"concurrency":5}' --filter-json '{"state":"open"}'
check '[[ $(jq -r ".issues | has(\"99\")" "$STATE") == "true" ]]' 'L12 再 init で issues を消さない'
check '[[ $(jq -r ".config.concurrency" "$STATE") == "5" ]]' 'L12 再 init で config を更新する'

# --- gh スタブ: 呼ばれた引数を gh.log に残し、GH_FIXTURE の中身を返す ---
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_FIXTURE" ;;
  "issue edit") exit "${GH_EDIT_EXIT:-0}" ;;
  "label list") echo '[]' ;;
  "label create") exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/gh"
export GH_LOG="$TMP/gh.log" GH_FIXTURE="$TMP/fixture.json"

# L12 の sess-c から F/S スイートの sess-d へ ownership を明示的に引き継ぐ。
SID=sess-c run lock-release
SID=sess-d run lock-acquire --lease-min 30
SID=sess-d run init --config-json '{"concurrency":2}' --filter-json '{"state":"open"}'

# F1: normal fetch claims a server-side eligible issue.
: > "$GH_LOG"
echo '[{"number":12,"title":"Fix login redirect","body":"b","url":"https://x/12","labels":[]}]' > "$GH_FIXTURE"
out=$(SID=sess-d run fetch --limit 2 --batch 1)
check '[[ $(jq -r ".[0].number" <<<"$out") == 12 ]]' 'F1 候補を 1 件返す'
check '[[ $(jq -r ".[0].slug" <<<"$out") == "issue-12-fix-login-redirect" ]]' 'F1 slug を生成する'
check 'grep -q -- "-label:dispatch/in-progress" "$GH_LOG"' 'F1 dispatch ラベルの negative qualifier を送る'
check 'grep -q -- "-label:dispatch/done" "$GH_LOG"' 'F1 dispatch/done も除外する'
check '! grep -q -- "no:assignee" "$GH_LOG"' 'F1 assignee 未指定では no:assignee を付けない'
check '[[ $(jq -r ".issues[\"12\"].status" "$STATE") == "claimed" ]]' 'F1 claim 済みとして記録する'

# F2-F4: no-assignee query, exhaustion, and failed claims.
: > "$GH_LOG"; echo '[]' > "$GH_FIXTURE"
SID=sess-d run fetch --limit 2 --batch 2 --assignee none >/dev/null
check 'grep -q -- "no:assignee" "$GH_LOG"' 'F2 未割当は no:assignee で表現する'
check '! grep -q -- "--assignee none" "$GH_LOG"' 'F2 --assignee none を渡さない'
out=$(SID=sess-d run fetch --limit 2 --batch 3)
check '[[ "$out" == "[]" ]]' 'F3 候補ゼロは空配列'
echo '[{"number":21,"title":"t","body":"b","url":"https://x/21","labels":[]}]' > "$GH_FIXTURE"
set +e; GH_EDIT_EXIT=1 SID=sess-d run fetch --limit 2 --batch 4 >/dev/null 2>&1; rc=$?; set -e
check '[[ $rc -eq 3 ]]' 'F4 claim 全滅は exit 3'

# F5: full windows of only known issues are exhaustion-unknown at the safety cap.
: > "$GH_LOG"
jq -n '[range(1;1001) | {number:.,title:"t",body:"b",url:"https://x",labels:[]}]' > "$GH_FIXTURE"
jq -n '[range(1;1001)] | {issues:(map({(tostring):{slug:"s",status:"done",batch:0}})|add),batches:[],leaked:[]}' > "$STATE"
set +e; SID=sess-d run fetch --limit 2 --batch 5 >/dev/null 2>&1; rc=$?; set -e
check '[[ $rc -eq 4 ]]' 'F5 上限まで満杯なら exit 4'
check '[[ $(grep -c -- "--limit 1000" "$GH_LOG") -ge 1 ]]' 'F5 上限 1000 を一度は問い合わせる'
check 'limit_not_over_1000' 'F5 --limit は 1000 を超えない'

# F6: expanding the window finds a later unclaimed issue.
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "issue list")
    lim=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--limit" ]] && { lim="$2"; break; }; shift; done
    if [[ "$lim" -le 4 ]]; then jq -n '[range(1;5)|{number:.,title:"t",body:"b",url:"https://x",labels:[]}]'
    else jq -n '[range(1;8)|{number:.,title:"t",body:"b",url:"https://x",labels:[]}]'; fi ;;
  "issue edit") exit "${GH_EDIT_EXIT:-0}" ;;
  "label list") echo '[]' ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$TMP/bin/gh"
: > "$GH_LOG"
jq -n '[range(1;7)] | {started_at:"t",filter:{},config:{},issues:(map({(tostring):{slug:"s",status:"done",batch:0}})|add),batches:[],leaked:[]}' > "$STATE"
out=$(SID=sess-d run fetch --limit 2 --batch 6)
check '[[ $(jq -r "length" <<<"$out") == "1" ]]' 'F6 新候補は 1 件だけ'
check '[[ $(jq -r ".[0].number" <<<"$out") == "7" ]]' 'F6 窓を広げて次窓の候補を拾う'
check 'grep -q -- "--limit 8" "$GH_LOG"' 'F6 窓が倍化される'

# sess-d remains the owner for Task 7.
SID=sess-d run init --config-json '{"concurrency":2}' --filter-json '{"state":"open"}'

# --- S1: mark-dispatched ---
jq -n '{issues:{"12":{slug:"issue-12-x",status:"claimed",batch:1,claimed_at:"2026-01-01T00:00:00Z"}},batches:[{n:1,issues:[12],started_at:"2026-01-01T00:00:00Z"}],leaked:[]}' > "$STATE"
SID=sess-d run mark-dispatched --issue 12
check '[[ $(jq -r ".issues[\"12\"].status" "$STATE") == "dispatched" ]]' 'S1 mark-dispatched が status を進める'

# --- S2: release removes state only after the GitHub label transition succeeds. ---
: > "$GH_LOG"
SID=sess-d run release --issue 12
check '[[ $(jq -r ".issues | has(\"12\")" "$STATE") == "false" ]]' 'S2 release がレコードを削除する'
check 'grep -q -- "--remove-label dispatch/in-progress" "$GH_LOG"' 'S2 release がラベルを外す'

# --- S3-S4b: reconcile keeps any potentially live work and only releases proven-orphan claims. ---
jq -n '{issues:{"13":{slug:"s",status:"dispatched",batch:1}},batches:[],leaked:[]}' > "$STATE"
out=$(SID=sess-d run reconcile)
check '[[ $(jq -r ".action" <<<"$out") == "abort" ]]' 'S3 dispatched が残っていれば abort'
jq -n '{issues:{"14":{slug:"gone",status:"claimed",batch:1}},batches:[],leaked:[]}' > "$STATE"
out=$(DISPATCH_DIR="$TMP/repo/.dispatch" LOOP_REPO_ROOT="$TMP/repo" SID=sess-d run reconcile)
check '[[ $(jq -r ".action" <<<"$out") == "ok" ]]' 'S4 痕跡の無い claimed は ok'
check '[[ $(jq -r ".issues | has(\"14\")" "$STATE") == "false" ]]' 'S4 痕跡の無い claimed を release する'
mkdir -p "$TMP/repo/.dispatch/alive" "$TMP/repo/.worktrees/alive"
echo '{"sonnet":{"surface_id":"surface:99"}}' > "$TMP/repo/.dispatch/alive/prewarm.json"
jq -n '{issues:{"15":{slug:"alive",status:"claimed",batch:1}},batches:[],leaked:[]}' > "$STATE"
out=$(DISPATCH_DIR="$TMP/repo/.dispatch" LOOP_REPO_ROOT="$TMP/repo" CMUX_BIN=/nonexistent SID=sess-d run reconcile)
check '[[ $(jq -r ".action" <<<"$out") == "abort" ]]' 'S4b 生存痕跡のある claimed は abort'
check '[[ $(jq -r ".issues | has(\"15\")" "$STATE") == "true" ]]' 'S4b レコードを残す'
rm -rf "$TMP/repo/.dispatch/alive" "$TMP/repo/.worktrees/alive"

# --- S5-S6: labels and terminal state are persisted. ---
: > "$GH_LOG"
SID=sess-d run ensure-labels
check '[[ $(grep -c -- "label create" "$GH_LOG") -eq 3 ]]' 'S5 3 ラベルを作成する'
jq -n '{issues:{"15":{slug:"s",status:"dispatched",batch:1}},batches:[],leaked:[]}' > "$STATE"
SID=sess-d run finalize --issue 15 --status done --pr-url https://x/pr/1
check '[[ $(jq -r ".issues[\"15\"].status" "$STATE") == "done" ]]' 'S6 finalize が status を書く'
check '[[ $(jq -r ".issues[\"15\"].pr_url" "$STATE") == "https://x/pr/1" ]]' 'S6 finalize が pr_url を書く'

# --- refinement: partial failures must fail closed and leave durable state. ---
jq -n '{issues:{"16":{slug:"release-fail",status:"claimed",batch:1}},batches:[],leaked:[]}' > "$STATE"
set +e; GH_EDIT_EXIT=1 SID=sess-d run release --issue 16 >/dev/null 2>&1; rc=$?; set -e
check '[[ $rc -ne 0 && $(jq -r ".issues | has(\"16\")" "$STATE") == "true" ]]' 'R1 release のラベル除去失敗は state を保持する'

jq -n '{issues:{"17":{slug:"reconcile-fail",status:"claimed",batch:1}},batches:[],leaked:[]}' > "$STATE"
set +e; out=$(GH_EDIT_EXIT=1 DISPATCH_DIR="$TMP/repo/.dispatch" LOOP_REPO_ROOT="$TMP/repo" SID=sess-d run reconcile); rc=$?; set -e
check '[[ $rc -eq 0 && $(jq -r ".action" <<<"$out") == "abort" && $(jq -r ".issues | has(\"17\")" "$STATE") == "true" ]]' 'R2 reconcile のラベル除去失敗は abort して state を保持する'

# state の atomic replace を拒否して claim 後の補償的 label removal を確認する。
echo '[{"number":30,"title":"state failure","body":"b","url":"https://x/30","labels":[]}]' > "$GH_FIXTURE"
: > "$GH_LOG"; chmod 500 "$TMP/repo/.dispatch-loop"
set +e; SID=sess-d run fetch --limit 1 --batch 7 >/dev/null 2>&1; rc=$?; set -e
chmod 700 "$TMP/repo/.dispatch-loop"
check '[[ $rc -eq 3 && $(jq -r ".issues | has(\"30\")" "$STATE") == "false" ]]' 'R3 claim の state 書き込み失敗は記録を残さない'
check 'grep -q -- "--remove-label dispatch/in-progress" "$GH_LOG"' 'R3 claim の state 書き込み失敗はラベルを補償的に外す'

# heartbeat を更新できなければ owner 操作は停止し、state を書き換えない。
before_state=$(cat "$STATE"); chmod 500 "$TMP/repo/.dispatch-loop/loop.lock.d"
set +e; SID=sess-d run heartbeat >/dev/null 2>&1; rc=$?; set -e
chmod 700 "$TMP/repo/.dispatch-loop/loop.lock.d"
check '[[ $rc -ne 0 && $(cat "$STATE") == "$before_state" ]]' 'R4 heartbeat 更新失敗は state を触らず失敗する'

# テストの終わりにロックを解放する。
SID=sess-d run lock-release

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
