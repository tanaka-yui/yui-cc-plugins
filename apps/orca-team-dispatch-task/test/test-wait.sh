#!/usr/bin/env bash
# 完了の待ち受け。**cursor を進めるのは ack だけ** (O22 / O23)。
# ack は「batch 全件を処理した」の宣言であり、見ただけでは処理ではない (O11)。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  SD=$(mktemp -d); mkdir -p "$SD/roles/design"
  echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$SD/run.json"
  echo '{"design":{"terminal":"term_w","task":"task_x","dispatch":"ctx_x"}}' > "$SD/workers.json"
  echo '{"status":"executing"}' > "$SD/roles/design/status.json"
  echo '{"ok":true,"result":{"runId":"run_x","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
  echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
  echo '{"ok":true,"result":{"state":"retained"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN; }
msg() { jq -nc --arg o "${1:-succeeded}" --arg i "${2:-m1}" --arg t "${3:-task_x}" \
  '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:$i,type:"worker_done",payload:{taskId:$t,dispatchId:"ctx_x",outcome:$o},body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
mixed() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d2",count:2,messages:[
    {id:"q1",type:"question",payload:{taskId:"task_x",dispatchId:"ctx_x"},body:"?"},
    {id:"m1",type:"worker_done",payload:{taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"},body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
w() { bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits "${1:-1}" --timeout-ms 1; }
dn() { echo '{"status":"done"}' > "$SD/roles/design/status.json"; }
er() { echo '{"status":"error"}' > "$SD/roles/design/status.json"; }

setup; bash "$P/bin/orca-wait.sh" --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "WT1 使用法エラー" || fail "WT1"; teardown

# WT2: check は --terminal を取る。--from は無い
setup; w >/dev/null 2>&1; l=$(grep 'orchestration check' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$l" == *--terminal* && "$l" != *--from* ]] && ok "WT2 check の argv" || fail "WT2 ($l)"; teardown

# WT3: **status だけでは終わらない。**worker_done を受けるまで待つ
setup; dn; w >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "WT3 worker_done を待つ" || fail "WT3 status だけで完了した"; teardown

# WT4: succeeded は exit 0 で outcome を stdout に出す
setup; dn; msg; out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] && ok "WT4 成功で 0" || fail "WT4 (rc=$rc out=$out)"; teardown

# WT5: **failed は exit 5。**merge へ進ませない
setup; er; msg failed; out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"outcome=failed"* ]] && ok "WT5 失敗で 5" || fail "WT5 (rc=$rc)"; teardown

# WT6: 再実行しても outcome を復元できる（received.json が正本）
setup; er; msg failed; w >/dev/null 2>&1
echo '{"ok":true,"result":{"runId":"run_x","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"outcome=failed"* ]] && ok "WT6 outcome を復元" || fail "WT6 (rc=$rc)"; teardown

# WT7: **他タスクの worker_done を自分のものにしない**
setup; dn; msg succeeded m1 other; w >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "WT7 identity で絞る" || fail "WT7 他タスクで完了した"; teardown

# WT8: outcome と status が食い違えば完了扱いにしない
setup; dn; msg failed; w >/dev/null 2>&1
[[ $? -ne 0 && $? -ne 5 ]] || [[ $(w >/dev/null 2>&1; echo $?) -ne 0 ]] \
  && ok "WT8 不一致では成功にしない" || fail "WT8 不一致で成功した"; teardown

# WT9: 再送されても二重に処理しない (at-least-once + 冪等消費)
setup; dn; msg succeeded m1; w >/dev/null 2>&1; msg succeeded m2; w >/dev/null 2>&1
[[ "$(jq 'length' "$SD/received.json")" == "1" ]] && ok "WT9 冪等" || fail "WT9 二重処理"; teardown

# WT10: **worker_done は release してから ack する**（Orca guide の既定。retain は
#       ユーザーの明示依頼が要る例外なので使わない）
setup; dn; msg; w >/dev/null 2>&1
r=$(grep -n 'worker-release' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(grep -n -- '--ack' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ok "WT10 release が ack より前" || fail "WT10 順序 ($r/$a)"
! grep -q 'worker-retain' "$ORCA_STUB_DIR/calls.log" || fail "WT10b retain を使っている"; teardown

# WT11: **release が pending / unknown なら ack しない**（exit 0 は完了の証明ではない）
setup; dn; msg
echo '{"ok":true,"result":{"state":"release_pending"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
w >/dev/null 2>&1
! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" && ok "WT11 pending で ack しない" \
  || fail "WT11 pending なのに ack した"; teardown
setup; dn; msg
echo '{"ok":true,"result":{"state":"release_unknown"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
w >/dev/null 2>&1
! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" && ok "WT11b unknown で ack しない" \
  || fail "WT11b unknown なのに ack した"; teardown

# WT11c: release_pending でも receipt は残す。ack はせず、release が通った再試行で完了する。
setup; dn; msg
echo '{"ok":true,"result":{"state":"release_pending"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
w >/dev/null 2>&1; rc=$?
first=$(jq -c . "$SD/received.json" 2>/dev/null)
echo '{"ok":true,"result":{"state":"retained"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
out=$(w 2>/dev/null); retry_rc=$?
[[ "$rc" -eq 1 && "$first" == '["worker_done|task_x|ctx_x|succeeded"]' && "$retry_rc" -eq 0 \
  && "$out" == *"outcome=succeeded"* ]] && ok "WT11c pending の receipt を再試行で完了" \
  || fail "WT11c (first=$rc receipt=$first retry=$retry_rc)"; teardown

# WT12: **処理できない型を含む batch は ack しない。**見ただけでは処理ではない (O11)
setup; dn; mixed; w >/dev/null 2>&1; rc=$?
! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" && [[ "$rc" -eq 1 ]] \
  && ok "WT12 未対応の型を含む batch を ack しない" || fail "WT12 (rc=$rc)"; teardown

# WT13: **他タスクの worker_done を含む batch も ack しない**（捨てて cursor を進めない）
setup; dn; msg succeeded m1 other; w >/dev/null 2>&1
! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" && ok "WT13 foreign を捨てない" \
  || fail "WT13 foreign 込みで ack した"; teardown

# WT14: 停止した worker は 4。**人の入力待ちは healthy**（CLI help の明記）。時間切れは 3
setup; echo '{"ok":true,"result":{"worker":{"state":"stopped"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"; w 3 >/dev/null 2>&1
[[ $? -eq 4 ]] || fail "WT14 停止を見逃した"; teardown
setup; echo '{"ok":true,"result":{"worker":{"state":"idle"},"observation":{"agentWait":"prompt"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"; w 1 >/dev/null 2>&1; rc=$?
l=$(grep 'worker-show' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 3 && "$l" == *--dispatch* && "$l" != *--worker* ]] \
  && ok "WT14 停止・待機・時間切れ・argv" || fail "WT14 (rc=$rc l=$l)"; teardown

# WT15: deliveryId が無い batch は不正。受信記録・release・ack の副作用を持たない
setup; dn
jq -nc '{ok:true,result:{runId:"run_x",count:1,messages:[
  {id:"m1",type:"worker_done",payload:{taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"},body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -e "$SD/received.json" ]] \
  && ! grep -q 'worker-release\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT15 deliveryId 欠落は副作用なし" || fail "WT15 (rc=$rc)"; teardown

# WT16: 同じ task/dispatch の逆 outcome は 2 件目の完了として消費せず、ack しない
setup; dn; msg succeeded; w >/dev/null 2>&1
: > "$ORCA_STUB_DIR/calls.log"; msg failed m2; w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(jq 'length' "$SD/received.json")" == "1" ]] \
  && ! grep -q 'worker-release\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT16 逆 outcome は fail-closed" || fail "WT16 (rc=$rc)"; teardown

# WT17: check transport failure は worker health を証明できないため 4。副作用を持たない
setup; dn; echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_check"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 4 && ! -e "$SD/received.json" ]] \
  && ! grep -q 'worker-release\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT17 check ok:false は副作用なし" || fail "WT17 (rc=$rc)"; teardown

# WT18: release / worker-show transport failure は 4、ack しない
setup; dn; msg; echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-release"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 4 && -e "$SD/received.json" ]] && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18a release ok:false は ack しない" || fail "WT18a (rc=$rc)"; teardown
setup; echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-show"
w 1 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 4 ]] && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18b worker-show ok:false は受信失敗" || fail "WT18b (rc=$rc)"; teardown

# WT19: null parent handle と非正の待機値は使用法エラー
setup; echo '{"run_id":"run_x","parent_handle":null,"repo_root":"/tmp"}' > "$SD/run.json"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19a null handle は使用法エラー" || fail "WT19a (rc=$rc)"; teardown
setup; bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 0 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19b max-waits を検証" || fail "WT19b (rc=$rc)"; teardown
setup; bash "$P/bin/orca-wait.sh" --status-dir "$SD" --timeout-ms nope >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19c timeout-ms を検証" || fail "WT19c (rc=$rc)"; teardown

# WT20: Task 3 consumer 契約の string receipt をそのまま保存する
setup; dn; msg; w >/dev/null 2>&1
[[ "$(jq -c . "$SD/received.json")" == '["worker_done|task_x|ctx_x|succeeded"]' ]] \
  && ok "WT20 string receipt 互換" || fail "WT20"; teardown

echo "---"; echo "failures: $fails"; exit "$fails"
