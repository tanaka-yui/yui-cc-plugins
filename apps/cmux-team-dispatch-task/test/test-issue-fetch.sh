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

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
