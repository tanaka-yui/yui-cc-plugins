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
  echo '{"roles":{"design":{"terminal":"term_w","task":"task_x","dispatch":"ctx_x","retained":false}}}' > "$SD/workers.json"
  echo '{"status":"executing"}' > "$SD/roles/design/status.json"
  echo '{"ok":true,"result":{"runId":"run_x","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
  echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN; }
msg() { jq -nc --arg o "${1:-succeeded}" --arg i "${2:-m1}" --arg t "${3:-task_x}" \
  '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:$i,type:"worker_done",payload:({taskId:$t,dispatchId:"ctx_x",outcome:$o}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
object_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"msg_object",type:"worker_done",payload:{taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"},body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
real_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"msg_real",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded",filesModified:["README.md"],reportPath:"/tmp/roles/design/result.md"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
rejected_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"msg_rejected",subject:"Rejected worker_done: spike done",type:"worker_done",payload:({taskId:"task_f2917652a612",dispatchId:"ctx_22efecad4b84",outcome:"succeeded",_orcaLifecycleRejection:{code:"dispatch_capability_invalid",reason:"The Dispatch capability is missing."}}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
status_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"msg_status",type:"status",payload:null,body:""}]}}' > "$ORCA_STUB_DIR/orchestration_check"; }
mixed() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d2",count:2,messages:[
    {id:"g1",type:"gate_request",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:"?"},
    {id:"m1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
w() { node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits "${1:-1}" --timeout-ms 1; }
dn() { echo '{"status":"done"}' > "$SD/roles/design/status.json"; }
er() { echo '{"status":"error"}' > "$SD/roles/design/status.json"; }

setup; node "$P/bin/orca-wait.ts" --bogus >/dev/null 2>&1
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

# WT4b: 実 Orca の worker_done.payload は JSON object ではなく JSON 文字列で返る。
setup; dn; real_msg; out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] && ok "WT4b 実 receipt の string payload" \
  || fail "WT4b (rc=$rc out=$out)"; teardown

# WT4c: 過去の object receipt も受け続ける。
setup; dn; object_msg; out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] && ok "WT4c object payload 互換" \
  || fail "WT4c (rc=$rc out=$out)"; teardown

# WT4d: Orca が reject した worker_done は outcome が succeeded でも完了ではない。
setup; dn
echo '{"roles":{"design":{"terminal":"term_w","task":"task_f2917652a612","dispatch":"ctx_22efecad4b84","retained":false}}}' > "$SD/workers.json"
rejected_msg; out=$(w 2>&1); rc=$?
release_or_ack=$(grep -c 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" || true)
[[ "$rc" -eq 1 && "$out" == *"dispatch_capability_invalid"* && "$out" == *"The Dispatch capability is missing."* \
  && ! -e "$SD/received.json" && "$release_or_ack" -eq 0 ]] \
  && ok "WT4d rejected worker_done を消費しない" || fail "WT4d (rc=$rc out=$out)"; teardown

# WT4e: null payload の status は誤って payload schema の問題と説明せず、未 ack で残す。
setup; status_msg; out=$(w 2>&1); rc=$?
release_or_ack=$(grep -c 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" || true)
[[ "$rc" -eq 1 && "$out" == *"this version handles only worker_done messages; the message was left unacknowledged"* \
  && ! -e "$SD/received.json" && "$release_or_ack" -eq 0 ]] \
  && ok "WT4e status message を未 ack で残す" || fail "WT4e (rc=$rc out=$out)"; teardown

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

# WT10: worker_done は retain してから ack する。解放は Step 6 だけの権限（spec D12）
setup; dn; msg; w >/dev/null 2>&1
r=$(grep -n 'worker-retain' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(grep -n -- '--ack' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ok "WT10 retain が ack より前" || fail "WT10 順序 ($r/$a)"
! grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" || fail "WT10b release を呼んだ"
[[ "$(jq -r '.roles.design.retained' "$SD/workers.json")" == "true" ]] \
  && ok "WT10c retained を記録" || fail "WT10c"; teardown

# WT11: retain の receipt が ok でなければ ack しない
setup; dn; msg
echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"worker-retain receipt was not ok"* && -e "$SD/received.json" ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT11 retain 失敗で ack しない" || fail "WT11 (rc=$rc out=$out)"; teardown

# WT11a: receipt が ok:true でも rc が非 0 なら信用せず ack しない
setup; dn; msg
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
echo 7 > "$ORCA_STUB_DIR/orchestration_worker-retain.rc"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"worker-retain failed (rc=7)"* ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT11a retain の ok:true でも非 0 rc は信用しない" || fail "WT11a (rc=$rc out=$out)"; teardown

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

# WT15: deliveryId が無い batch は不正。受信記録・retain・ack の副作用を持たない
setup; dn
jq -nc '{ok:true,result:{runId:"run_x",count:1,messages:[
  {id:"m1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -e "$SD/received.json" ]] \
  && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT15 deliveryId 欠落は副作用なし" || fail "WT15 (rc=$rc)"; teardown

# WT16: 同じ task/dispatch の逆 outcome は 2 件目の完了として消費せず、ack しない
setup; dn; msg succeeded; w >/dev/null 2>&1
: > "$ORCA_STUB_DIR/calls.log"; msg failed m2; w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(jq 'length' "$SD/received.json")" == "1" ]] \
  && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT16 逆 outcome は fail-closed" || fail "WT16 (rc=$rc)"; teardown

# WT17: check transport failure は worker health を証明できないため 4。理由を出し、副作用を持たない
setup; dn; echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"check receipt was not ok"* && ! -e "$SD/received.json" ]] \
  && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT17 check ok:false を診断して副作用なし" || fail "WT17 (rc=$rc out=$out)"; teardown

# WT18: worker-show transport failure は 4、ack しない
setup; echo '{"ok":false,"error":"unavailable"}' > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 1 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"worker-show receipt was not ok"* ]] && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18b worker-show ok:false を診断して受信失敗" || fail "WT18b (rc=$rc out=$out)"; teardown

# WT18c: ack 側の transport failure も判定不能（4）。batch は replay される。
setup; dn; msg
printf '%s\n' '#!/usr/bin/env bash' \
  'for arg in "$@"; do [[ "$arg" == --ack ]] && printf "1\n" > "$ORCA_STUB_DIR/orchestration_check.rc"; done' \
  > "$ORCA_STUB_DIR/orchestration_check.hook"
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"ack transport failed; the batch will replay"* ]] \
  && ok "WT18c ack transport failure は 4" || fail "WT18c (rc=$rc out=$out)"; teardown

# WT18d: 壊れた receipt は原因を示して止め、ack しない。
setup; dn; msg; printf '%s\n' '{not-json' > "$SD/received.json"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"received outcome record is invalid or unreadable"* ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18d 壊れた receipt を無言で返さない" || fail "WT18d (rc=$rc out=$out)"; teardown

# WT18e: keepalive は stderr に混ざっても check JSON を壊さない (O10)。
setup; dn; msg
printf '%s\n' '#!/usr/bin/env bash' 'printf "keepalive\\n" >&2' > "$ORCA_STUB_DIR/orchestration_check.hook"
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* && "$out" != *keepalive* ]] \
  && ok "WT18e keepalive stderr を JSON に混ぜない" || fail "WT18e (rc=$rc out=$out)"; teardown

# WT18f: **空の received.json を「receipt 0 件」と読まない。**jq は空入力に空を返して 0 で
#        終わるので、検査しないと空のまま追記して write が成功し、ack が通って message が消える
setup; dn; msg; : > "$SD/received.json"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"received outcome record in $SD is empty"* && ! -s "$SD/received.json" ]] \
  && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18f 空の receipt 台帳を ack しない" || fail "WT18f (rc=$rc out=$out)"; teardown

# WT18g: receipt を書けなかったのは **retain の記録に失敗したのと同じ種類の事故**である。
#        ふつうの filesystem エラーなので「再実行しても無駄」の 1 ではなく、
#        「canonical な wait をやり直せ」の 4 に落とす
setup; dn; msg; chmod 500 "$SD"
out=$(w 2>&1); rc=$?
chmod -R 700 "$SD"
[[ "$rc" -eq 4 && "$out" == *"could not record the worker outcome for dispatch 'ctx_x'"* ]] \
  && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT18g receipt の write 失敗は再実行可能な 4" || fail "WT18g (rc=$rc out=$out)"; teardown

# WT19: null parent handle と非正の待機値は使用法エラー
setup; echo '{"run_id":"run_x","parent_handle":null,"repo_root":"/tmp"}' > "$SD/run.json"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19a null handle は使用法エラー" || fail "WT19a (rc=$rc)"; teardown
setup; node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits 0 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19b max-waits を検証" || fail "WT19b (rc=$rc)"; teardown
setup; node "$P/bin/orca-wait.ts" --status-dir "$SD" --timeout-ms nope >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19c timeout-ms を検証" || fail "WT19c (rc=$rc)"; teardown

# WT20: Task 3 consumer 契約の string receipt をそのまま保存する
setup; dn; msg; w >/dev/null 2>&1
[[ "$(jq -c . "$SD/received.json")" == '["worker_done|task_x|ctx_x|succeeded"]' ]] \
  && ok "WT20 string receipt 互換" || fail "WT20"; teardown

# --- 2 タスクの集約待機 ---
setup2() {
  setup
  SD2=$(mktemp -d); mkdir -p "$SD2/roles/design"
  echo '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}' > "$SD2/run.json"
  echo '{"roles":{"design":{"terminal":"term_w2","task":"task_y","dispatch":"ctx_y","retained":false}}}' \
    > "$SD2/workers.json"
  echo '{"status":"executing"}' > "$SD2/roles/design/status.json"
}
teardown2() { rm -rf "$SD2"; teardown; }
w2() { node "$P/bin/orca-wait.ts" --status-dir "$SD" --status-dir "$SD2" \
         --max-waits "${1:-1}" --timeout-ms 1; }
both_msg() { jq -nc --arg o1 "${1:-succeeded}" --arg o2 "${2:-succeeded}" \
  '{ok:true,result:{runId:"run_x",deliveryId:"d9",count:2,messages:[
    {id:"n1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:$o1}|tojson),body:""},
    {id:"n2",type:"worker_done",payload:({taskId:"task_y",dispatchId:"ctx_y",outcome:$o2}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
dn2() { echo '{"status":"done"}' > "$SD2/roles/design/status.json"; }
er2() { echo '{"status":"error"}' > "$SD2/roles/design/status.json"; }

# WT21: 1 batch に 2 タスクの worker_done が同居しても、両方を正しく振り分ける
setup2; dn; dn2; both_msg; out=$(w2 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -c . "$SD/received.json")" == '["worker_done|task_x|ctx_x|succeeded"]' \
   && "$(jq -c . "$SD2/received.json")" == '["worker_done|task_y|ctx_y|succeeded"]' ]] \
  && ok "WT21 receipt を振り分ける" || fail "WT21 (rc=$rc out=$out)"; teardown2

# WT22: settle した dispatch すべてを retain してから ack は 1 回
setup2; dn; dn2; both_msg; w2 >/dev/null 2>&1
[[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 \
   && "$(grep -c -- '--ack' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "WT22 retain 2 回・ack 1 回" || fail "WT22"; teardown2

# WT23: 1 件成功・1 件失敗は 5。両方の receipt は残る
setup2; dn; er2; both_msg succeeded failed; w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 5 && -s "$SD/received.json" && -s "$SD2/received.json" ]] \
  && ok "WT23 部分失敗は 5" || fail "WT23 (rc=$rc)"; teardown2

# WT24: 期待集合に無い dispatch が混ざったら ack も retain もしない
setup2; dn; dn2
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d9",count:2,messages:[
  {id:"n1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""},
  {id:"n3",type:"worker_done",payload:({taskId:"task_z",dispatchId:"ctx_z",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worker-retain\|--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT24 未知の dispatch を含む batch を捨てない" || fail "WT24 (rc=$rc)"; teardown2

# WT25: parent_handle が食い違う status-dir を混ぜたら使用法エラー
setup2; echo '{"run_id":"run_x","parent_handle":"term_q","repo_root":"/tmp"}' > "$SD2/run.json"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT25a parent 不一致は 2" || fail "WT25a (rc=$rc)"; teardown2
setup2; echo '{"run_id":"run_y","parent_handle":"term_p","repo_root":"/tmp"}' > "$SD2/run.json"
w2 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT25b run 不一致は 2" || fail "WT25b (rc=$rc)"; teardown2
# WT25c: **同じ (task, dispatch) を 2 つが名乗ったら開始時に閉じる。**idx_of は先頭
#        しか返さないので、batch は片方だけに記録されたまま ack され、もう片方は永久に
#        settle しない。他の identity 不一致と同じ扱いにする。
#        **2 つの dir でも、1 つの dir の 2 役でも同じ事故である**（WT25d が後者）
setup2; cp "$SD/workers.json" "$SD2/workers.json"
out=$(w2 2>&1); rc=$?
[[ "$rc" -eq 2 && "$out" == *"the same dispatch is named twice"* ]] \
  && ok "WT25c 同一 dispatch の重複は 2" || fail "WT25c (rc=$rc out=$out)"; teardown2

# WT26: 片方だけ終端なら終わらない（もう片方を待ち続けて時間切れ 3）。
#       **先に settle した dispatch を health check にかけない** — 実測では決着済みの
#       worker-show は state 'succeeded' を返し、許容集合の外なので、まだ働いている
#       兄弟ごと wait を 4 で落としてしまう
setup2; dn; msg
printf '%s\n' '#!/usr/bin/env bash' \
  'st=active; for a in "$@"; do [[ "$a" == ctx_x ]] && st=succeeded; done' \
  'printf "{\"ok\":true,\"result\":{\"worker\":{\"state\":\"%s\"},\"observation\":{\"agentWait\":null}}}\n" \
     "$st" > "$ORCA_STUB_DIR/orchestration_worker-show"' \
  > "$ORCA_STUB_DIR/orchestration_worker-show.hook"
chmod +x "$ORCA_STUB_DIR/orchestration_worker-show.hook"
out=$(w2 2 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" != *"is 'succeeded'"* ]] \
  && ok "WT26 決着済みを health check せず全件終端まで待つ" || fail "WT26 (rc=$rc out=$out)"; teardown2

# --- レビューモード: 1 タスクに 2 dispatch (Stage B) ---
# ★ ここが壊れると **batch ごと永久に詰まる**。reviewer の worker_done を未知として
#   扱った瞬間、drain は ack せずに戻り、design の成果も取り出せなくなる。
setup_rv() {
  setup
  mkdir -p "$SD/roles/design_review"
  jq -nc '{roles:{
      design:       {terminal:"term_d",task:"task_d",dispatch:"ctx_d",retained:false},
      design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r",retained:false}}}' \
    > "$SD/workers.json"
  echo '{"status":"executing"}' > "$SD/roles/design_review/status.json"
}
both_msg() { jq -nc --arg dz "${1:-succeeded}" --arg rv "${2:-succeeded}" \
  '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:2,messages:[
    {id:"m_r",type:"worker_done",payload:({taskId:"task_r",dispatchId:"ctx_r",outcome:$rv}|tojson),body:""},
    {id:"m_d",type:"worker_done",payload:({taskId:"task_d",dispatchId:"ctx_d",outcome:$dz}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
only_d_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"m_d",type:"worker_done",payload:({taskId:"task_d",dispatchId:"ctx_d",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
only_r_msg() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
    {id:"m_r",type:"worker_done",payload:({taskId:"task_r",dispatchId:"ctx_r",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }
rvdn() { echo '{"status":"done"}' > "$SD/roles/design_review/status.json"; }

# WT30: 1 batch に 2 役の worker_done が同居しても両方を振り分け、ack は 1 回。
setup_rv; both_msg; dn; rvdn
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(grep -c -- '--ack d1' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 ]] \
  && [[ "$(jq -r '[.roles[].retained] | sort | join(",")' "$SD/workers.json")" == "true,true" ]] \
  && ok "WT30 2 役の worker_done を振り分け、retain 2 回・ack 1 回" || fail "WT30 (rc=$rc out=$out)"; teardown

# WT31: ★ **reviewer の worker_done を待たずに終わらない。**先に戻ると、その message は
#       あとから来て次の batch を詰まらせる。design だけ終端でも 3 (継続) である。
setup_rv; only_d_msg; dn
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 3 ]] && ok "WT31 reviewer の receipt が揃うまで終端にしない" || fail "WT31 (rc=$rc out=$out)"; teardown

# WT32: ★ **タスクの結末を決めるのは design。**reviewer が失敗しても、それは
#       「レビューが付かなかった」であって成果が失われたわけではない。黙らせもしない。
setup_rv; both_msg succeeded failed; dn
echo '{"status":"error"}' > "$SD/roles/design_review/status.json"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *'role=design_review'* && "$out" == *'outcome=failed'* ]] \
  && ok "WT32 reviewer の失敗はタスクを失敗にしない（が黙らせない）" || fail "WT32 (rc=$rc out=$out)"; teardown

# WT33: design が失敗すればタスクは失敗 (5)。reviewer が成功していても変わらない。
setup_rv; both_msg failed succeeded; er; rvdn
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 5 ]] && ok "WT33 design の失敗はタスクの失敗" || fail "WT33 (rc=$rc)"; teardown

# WT34: 未 dispatch の役は飛ばす。片方だけ task があって dispatch が無いのは
#       **記録の破れ**なので開始時に閉じる（routing できない worker_done が来る）。
setup_rv
jq -nc '{roles:{design:{},design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r",retained:false}}}' \
  > "$SD/workers.json"
only_r_msg; w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] || fail "WT34 未 dispatch の役を飛ばせていない (rc=$rc)"
jq -nc '{roles:{design:{task:"task_d"},design_review:{task:"task_r",dispatch:"ctx_r"}}}' \
  > "$SD/workers.json"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 2 && "$out" == *"incomplete for role 'design'"* ]] \
  && ok "WT34 未 dispatch は飛ばし、片欠けは開始時に閉じる" || fail "WT34 片欠け (rc=$rc out=$out)"; teardown

# WT35: 1 つの status dir の 2 役が同じ dispatch を名乗ったら開始時に閉じる（WT25c の同型）。
setup_rv
jq -nc '{roles:{design:{task:"task_d",dispatch:"ctx_same"},
                design_review:{task:"task_d",dispatch:"ctx_same"}}}' > "$SD/workers.json"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 2 && "$out" == *"the same dispatch is named twice"* ]] \
  && ok "WT35 同一 dir の 2 役の重複も 2" || fail "WT35 (rc=$rc out=$out)"; teardown

# WT36: ★ **1 タスクに 3 dispatch（design / design_review / exec）でも取りこぼさない。**
#       exec は 2 段目で足されるので、待機の期待集合は **そのときの workers.json** から
#       作られる。集合の作り方が役の数に依存していたら、ここで落ちる。
setup
mkdir -p "$SD/roles/design_review" "$SD/roles/exec"
jq -nc '{integration_role:"exec", roles:{
    design:       {terminal:"t_d",task:"task_d",dispatch:"ctx_d",retained:false},
    design_review:{terminal:"t_r",task:"task_r",dispatch:"ctx_r",retained:false},
    exec:         {terminal:"t_x",task:"task_x2",dispatch:"ctx_x2",retained:false}}}' \
  > "$SD/workers.json"
for r in design design_review exec; do echo '{"status":"done"}' > "$SD/roles/$r/status.json"; done
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d3",count:3,messages:[
  {id:"a",type:"worker_done",payload:({taskId:"task_d",dispatchId:"ctx_d",outcome:"succeeded"}|tojson),body:""},
  {id:"b",type:"worker_done",payload:({taskId:"task_r",dispatchId:"ctx_r",outcome:"succeeded"}|tojson),body:""},
  {id:"c",type:"worker_done",payload:({taskId:"task_x2",dispatchId:"ctx_x2",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 3 ]] \
  && [[ "$(grep -c -- '--ack d3' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(grep -c 'role=' <<<"$out")" -eq 3 ]] \
  && ok "WT36 3 役を 1 batch で drain し retain 3 回・ack 1 回" || fail "WT36 (rc=$rc) $out"
teardown

# WT37: ★ **タスクの結末を決めるのは design のままではいけない。**phase_b=on では成果は
#       exec に載る。design が done でも **exec が失敗していればタスクは失敗**である。
setup
mkdir -p "$SD/roles/exec"
jq -nc '{integration_role:"exec", roles:{
    design:{terminal:"t_d",task:"task_d",dispatch:"ctx_d",retained:false},
    exec:  {terminal:"t_x",task:"task_x2",dispatch:"ctx_x2",retained:false}}}' > "$SD/workers.json"
echo '{"status":"done"}'  > "$SD/roles/design/status.json"
echo '{"status":"error"}' > "$SD/roles/exec/status.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d4",count:2,messages:[
  {id:"a",type:"worker_done",payload:({taskId:"task_d",dispatchId:"ctx_d",outcome:"succeeded"}|tojson),body:""},
  {id:"b",type:"worker_done",payload:({taskId:"task_x2",dispatchId:"ctx_x2",outcome:"failed"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 5 ]] && ok "WT37 phase_b=on では exec の失敗がタスクの失敗" || fail "WT37 (rc=$rc)"
teardown

# WT38: ★ **1 タスク 4 dispatch でも取りこぼさない。**期待集合は workers.json から
#       作られるので、役の数に依存する書き方をしていたらここで落ちる。
setup
for r in design_review exec exec_review; do mkdir -p "$SD/roles/$r"; done
jq -nc '{integration_role:"exec", roles:{
    design:       {task:"t1",dispatch:"c1",retained:false},
    design_review:{task:"t2",dispatch:"c2",retained:false},
    exec:         {task:"t3",dispatch:"c3",retained:false},
    exec_review:  {task:"t4",dispatch:"c4",retained:false}}}' > "$SD/workers.json"
for r in design design_review exec exec_review; do echo '{"status":"done"}' > "$SD/roles/$r/status.json"; done
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d5",count:4,messages:[
  {id:"a",type:"worker_done",payload:({taskId:"t1",dispatchId:"c1",outcome:"succeeded"}|tojson),body:""},
  {id:"b",type:"worker_done",payload:({taskId:"t2",dispatchId:"c2",outcome:"succeeded"}|tojson),body:""},
  {id:"c",type:"worker_done",payload:({taskId:"t3",dispatchId:"c3",outcome:"succeeded"}|tojson),body:""},
  {id:"d",type:"worker_done",payload:({taskId:"t4",dispatchId:"c4",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 4 ]] \
  && [[ "$(grep -c -- '--ack d5' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(grep -c 'role=' <<<"$out")" -eq 4 ]] \
  && ok "WT38 4 役を 1 batch で drain し retain 4 回・ack 1 回" || fail "WT38 (rc=$rc) $out"
teardown

question_msg() {   # $1=message id
  jq -nc --arg i "${1:-q1}" '{ok:true,result:{runId:"run_x",deliveryId:"dq",count:1,messages:[
    {id:$i,type:"question",subject:"Question",body:"which layout?",
     payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson)}]}}' \
    > "$ORCA_STUB_DIR/orchestration_check"
}

# WT41: ★ **`question` は詰まりではなく「人へ取り次げ」である。**worker は `ask` で
#       ブロックしており、**親は `orchestration reply` で答えられる**。未知として扱って
#       batch を止めると、答えれば進む dispatch が永久に止まる（実測で踏んだ）。
setup; question_msg q1
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 6 ]] \
  && [[ "$out" == *'which layout?'* ]] \
  && [[ "$out" == *'orchestration reply --id q1'* ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT41 question は exit 6 で中継へ回し、ack しない" || fail "WT41 (rc=$rc) $out"
teardown

# WT42: ★ **一度出した質問で二度止まらない。**取り次いだ時点で用は済んでいる
#       （worker が動き出すのは `reply` であって ack ではない）。記録しないと、
#       答えたあとも同じ質問で永久に止まり続ける。
setup; question_msg q1
w >/dev/null 2>&1
[[ "$(jq -c . "$SD/questions.json" 2>/dev/null)" == '["q1"]' ]] || fail "WT42 記録していない"
question_msg q1; dn
out=$(w 2>&1); rc=$?
[[ "$rc" -ne 6 ]] && [[ "$out" == *'already relayed'* ]] \
  && ok "WT42 取り次ぎ済みの質問では止まらない" || fail "WT42 (rc=$rc) $out"
teardown

# WT43: 別の質問なら改めて取り次ぐ（記録は id 単位である）。
setup; question_msg q1; w >/dev/null 2>&1
question_msg q2; out=$(w 2>&1); rc=$?
[[ "$rc" -eq 6 && "$out" == *'--id q2'* ]] \
  && ok "WT43 別の質問は改めて取り次ぐ" || fail "WT43 (rc=$rc)"
teardown

# WT44: ★ **答え終えた質問は queue から流れなければならない。**同じ batch に載っている
#       `worker_done` は、質問が退かない限り永久に後ろで待つ（実測で踏んだ）。
#       1 回目は取り次いで止まり、2 回目は通って batch ごと ack される。
setup; dn
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d9",count:2,messages:[
  {id:"q9",type:"question",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:"?"},
  {id:"m9",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w >/dev/null 2>&1; rc1=$?
acked1=$(grep -c 'orchestration check.*--ack' "$ORCA_STUB_DIR/calls.log")
w >/dev/null 2>&1; rc2=$?
acked2=$(grep -c 'orchestration check.*--ack' "$ORCA_STUB_DIR/calls.log")
[[ "$rc1" -eq 6 && "$acked1" -eq 0 && "$rc2" -eq 0 && "$acked2" -ge 1 ]] \
  && ok "WT44 答えたあと同じ batch が流れる" || fail "WT44 (rc=$rc1/$rc2 ack=$acked1/$acked2)"
teardown

# ── 起床（アイドルな worker を動かす）────────────────────────────────────
# ★ **配送は起床ではない。**`orchestration send` はメールボックスに入れるだけで、ターンを
#   終えた worker を起こさない（実測 2026-09-10: 1 Run の 4 worker 全員が
#   `completion-accepted` を未読のまま停止した）。返事を出したら端末も叩く。
wsetup() {   # merge_ready を 1 通投げて、親が返事を返す場面を作る
  setup; mkdir -p "$SD/roles/design"; printf 'did it\n' > "$SD/roles/design/result.md"
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
  jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dm",count:1,messages:[
    {id:"mr",type:"merge_ready",subject:"merge_ready: n1",
     payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:""}]}}' \
    > "$ORCA_STUB_DIR/orchestration_check"
}
typed() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" 2>/dev/null | grep -c '^term_w$'; }

# WT40: 受理を送った直後に、その役の端末を起こす。
wsetup; w >/dev/null 2>&1
grep -q 'terminal send' "$ORCA_STUB_DIR/calls.log" && [[ "$(typed)" -ge 1 ]] \
  && ok "WT60 受理のあとに端末を起こす" || fail "WT60"
teardown

# WT41: 差し戻しでも同じ。**返事を出した以上、読ませなければ意味が無い。**
wsetup; rm -f "$SD/roles/design/result.md"; w >/dev/null 2>&1
a=$(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log")
grep -q 'completion-remediation' <<<"$a" && grep -qxF 'term_w' <<<"$a" \
  && ok "WT61 差し戻しのあとも起こす" || fail "WT61"
teardown

# WT42: ★ **起こせなくても batch を止めない。**配送は send の exit code で確定している。
#      起床の失敗でそれを覆すと、届いた返事が「届かなかったこと」にされる。
wsetup; echo '{"ok":false,"error":{"message":"gone"}}' > "$ORCA_STUB_DIR/terminal_send"
w >/dev/null 2>&1; rc=$?
[[ "$rc" -ne 4 ]] && grep -q 'completion-accepted' "$ORCA_STUB_DIR/argv.log" \
  && ok "WT62 起床の失敗は batch を止めない" || fail "WT62 (rc=$rc)"
teardown

# WT43: ★ **待機中も起こし直す。**返事の直後の 1 回が空振りしたら、24 時間だれも
#      気づかない。merge_ready_sent のまま返事済みの役だけを、間隔をあけて叩く。
setup; mkdir -p "$SD/roles/design"
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
printf '%s\n' '{"phase":"merge_ready_sent","generation":1,"nonce":"n1"}' \
  > "$SD/roles/design/completion.json"
ORCA_WAKE_INTERVAL_SECONDS=0 node "$P/bin/orca-wait.ts" --status-dir "$SD" \
  --max-waits 2 --timeout-ms 1 >/dev/null 2>&1
[[ "$(typed)" -ge 2 ]] && ok "WT63 待機中も起こし直す" || fail "WT63 (typed=$(typed))"
teardown

# WT44: ★ **間隔をあける。**5 分ごとに叩くと 24 時間で 288 回になる。既定は 30 分。
setup; mkdir -p "$SD/roles/design"
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
printf '%s\n' '{"phase":"merge_ready_sent","generation":1,"nonce":"n1"}' \
  > "$SD/roles/design/completion.json"
node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits 3 --timeout-ms 1 >/dev/null 2>&1
[[ "$(typed)" -eq 1 ]] && ok "WT64 起こし直しは間隔をあける" || fail "WT64 (typed=$(typed))"
teardown

# WT45: 働いている役（merge_ready をまだ出していない）は叩かない。
setup; mkdir -p "$SD/roles/design"
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
printf '%s\n' '{"phase":"prepared","generation":1,"nonce":"n1"}' \
  > "$SD/roles/design/completion.json"
ORCA_WAKE_INTERVAL_SECONDS=0 node "$P/bin/orca-wait.ts" --status-dir "$SD" \
  --max-waits 2 --timeout-ms 1 >/dev/null 2>&1
[[ "$(typed)" -eq 0 ]] && ok "WT65 働いている役は叩かない" || fail "WT65 (typed=$(typed))"
teardown

# ── waiter_exists ────────────────────────────────────────────────────────
# ★ 段を足すと待機を一度止めて再起動することになるが、**サーバ側の waiter は
#   すぐには消えない**（実測 2026-09-10: 再起動が waiter_exists で弾かれ、親が降りた）。
#   これは「壊れた」ではなく「まだ空いていない」なので、待って試し直す。
# `--wait` のときだけ失敗させる。最初の drain の check は通さないと、待機に入る前に降りる
fail_on_wait() {   # $1=error code
  cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<EOS
#!/usr/bin/env bash
for a in "\$@"; do
  [[ "\$a" == --wait ]] || continue
  printf '%s\\n' '{"ok":false,"error":{"code":"$1"}}' > "\$ORCA_STUB_DIR/orchestration_check"; exit 0
done
printf '%s\\n' '{"ok":true,"result":{"runId":"run_x","count":0,"messages":[]}}' \
  > "\$ORCA_STUB_DIR/orchestration_check"
EOS
  chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
}
waits() { grep -c 'orchestration check .*--wait' "$ORCA_STUB_DIR/calls.log"; }

setup; fail_on_wait waiter_exists
ORCA_WAITER_RETRY_SECONDS=0 ORCA_WAITER_RETRY_TRIES=3 node "$P/bin/orca-wait.ts" \
  --status-dir "$SD" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1; rc=$?
n=$(waits)
[[ "$rc" -eq 4 && "$n" -eq 4 ]] && ok "WT66 waiter_exists は試し直す" || fail "WT66 (rc=$rc n=$n)"
teardown

# WT47: waiter_exists 以外の失敗は今までどおり即 exit 4（無闇に粘らない）。
setup; fail_on_wait forbidden
ORCA_WAITER_RETRY_SECONDS=0 node "$P/bin/orca-wait.ts" --status-dir "$SD" \
  --max-waits 1 --timeout-ms 1 >/dev/null 2>&1; rc=$?
n=$(waits)
[[ "$rc" -eq 4 && "$n" -eq 1 ]] && ok "WT67 他の失敗は粘らない" || fail "WT67 (rc=$rc n=$n)"
teardown

# WT48: ★ **既定の待機は 24 時間**（5 分 × 288）。worker を 24 時間待たせるのに親が
#      1 時間で降りたら、待たせた意味が無い。
grep -q 'DEFAULT_MAX_WAITS = 288' "$P/bin/orca-wait.ts" && ok "WT68 既定の --max-waits は 288" || fail "WT68"

# WT69: ★ **heartbeat で batch を止めない。**Orca の worker preamble は 5 分ごとに
#      heartbeat を送らせる。未知の型として扱うと、起動した**全 dispatch が永久に詰まる**
#      （実測 2026-09-10）。捨てても失われる内容は無い — outcome も nonce も質問も運ばない。
setup; dn
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dh",count:2,messages:[
  {id:"hb",type:"heartbeat",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:""},
  {id:"m1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] \
  && ok "WT69 heartbeat は batch を止めない" || fail "WT69 (rc=$rc out=$out)"
teardown


# WT70: ★ **起動後に増えた段の dispatch で batch を落とさない。**`--phase exec` は、この
#      待機が走っている最中に workers.json へ 2 段目を足す（実測 2026-09-11: exec の
#      merge_ready が unknown dispatch として exit 1 になり、wait を作り直すまで drain
#      できなかった）。ack していない以上 batch は残っているので、読み直して処理する。
setup; dn
mkdir -p "$SD/roles/exec"; echo 'built' > "$SD/roles/exec/result.md"
export WT70_SD="$SD"
cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<'HOOK'
#!/usr/bin/env bash
jq -c '.roles.exec = {"terminal":"term_e","task":"task_x","dispatch":"ctx_e","retained":false}' \
  "$WT70_SD/workers.json" > "$WT70_SD/w.tmp" && mv "$WT70_SD/w.tmp" "$WT70_SD/workers.json"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d70",count:1,messages:[
  {id:"mr70",type:"merge_ready",subject:"merge_ready: n70",payload:({taskId:"task_x",dispatchId:"ctx_e"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1); rc=$?
[[ "$rc" -ne 1 && "$out" == *"accepted exec"* ]] \
  && ok "WT70 待機中に増えた dispatch を読み直して処理する" || fail "WT70 (rc=$rc out=$out)"
unset WT70_SD; teardown

# WT71: **読み直しても増えていなければ、それは本当に未知である。**ack せずに 1 で止まる。
setup; dn
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d71",count:1,messages:[
  {id:"mr71",type:"merge_ready",subject:"merge_ready: n71",payload:({taskId:"task_x",dispatchId:"ctx_zzz"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1); rc=$?
acks=$(grep -c -- '--ack' "$ORCA_STUB_DIR/calls.log" || true)
[[ "$rc" -eq 1 && "$acks" -eq 0 && "$out" == *"does not know"* ]] \
  && ok "WT71 読み直しても未知なら ack せずに止まる" || fail "WT71 (rc=$rc acks=$acks out=$out)"
teardown


# ── 無レビューの可視化 ────────────────────────────────────────────────────
# ★ レビュー役が起きているのに verdict が 1 つも残らないまま終わることが起きる
#   （実測 2026-09-11: exec の review 待ちが waiter_exists で始められず、verdict 無しで
#   成果を差し出して succeeded になった）。**差し戻さない。見えるようにする。**
reviewed_setup() {
  setup
  cat > "$SD/workers.json" <<'JSON'
{"integration_role":"exec","roles":{
  "design":{"terminal":"term_d","task":"task_x","dispatch":"ctx_x","retained":false},
  "exec":{"terminal":"term_e","task":"task_x","dispatch":"ctx_e","retained":false},
  "exec_review":{"terminal":"term_er","task":"task_x","dispatch":"ctx_er","retained":false}}}
JSON
  mkdir -p "$SD/roles/exec" "$SD/review"; printf 'built\n' > "$SD/roles/exec/result.md"
}
exec_merge_ready() { jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dm",count:1,messages:[
  {id:"mr",type:"merge_ready",subject:"merge_ready: nx",payload:({taskId:"task_x",dispatchId:"ctx_e"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"; }

# WT72: verdict が 1 つも無ければ、受理はするが UNREVIEWED と言う。
reviewed_setup; exec_merge_ready; out=$(w 2>&1)
[[ "$out" == *"accepted exec"* && "$out" == *"UNREVIEWED"* ]] \
  && ok "WT72 無レビューの受理を名指しする" || fail "WT72 (out=$out)"; teardown

# WT73: verdict が在って届いていれば黙る。**正常な往復を警告で汚さない。**
reviewed_setup; printf 'ok\nVERDICT: approved\n' > "$SD/review/code-round-1-findings.md"
jq -nc '[{to:"exec",subject:"review-verdict: round 1",message_id:"m1",at:1}]' > "$SD/sent.json"
exec_merge_ready; out=$(w 2>&1)
[[ "$out" == *"accepted exec"* && "$out" != *"UNREVIEWED"* ]] \
  && ok "WT73 verdict が在れば警告しない" || fail "WT73 (out=$out)"; teardown

# WT77: ★ **findings が在っても、届いていなければレビューではない**（実測 2026-09-12:
#       依頼側が先に決着したため verdict が受け取られず、findings だけが残った）。
reviewed_setup; printf 'ok\nVERDICT: approved\n' > "$SD/review/code-round-1-findings.md"
exec_merge_ready; out=$(w 2>&1)
[[ "$out" == *"accepted exec"* && "$out" == *"UNREVIEWED"* ]] \
  && ok "WT77 未配送の findings はレビューと数えない" || fail "WT77 (out=$out)"; teardown

# WT74: 最終行にも載せる。result.md を読まなくても無レビューだと分かる。
reviewed_setup
printf '{"status":"done"}\n' > "$SD/roles/exec/status.json"
jq -nc '["worker_done|task_x|ctx_x|succeeded","worker_done|task_x|ctx_e|succeeded","worker_done|task_x|ctx_er|succeeded"]' \
  > "$SD/received.json"
out=$(w 2>/dev/null); rc=$?
# ★ **行ごとに見る。**文字列全体への glob は行をまたいで一致するので、design の行に
#   載っていないことを確かめたつもりで exec の行の語を拾ってしまう
l_exec=$(grep 'role=exec ' <<<"$out"); l_design=$(grep 'role=design ' <<<"$out")
[[ "$rc" -eq 0 && "$l_exec" == *"review=unreviewed"* && "$l_design" != *"review=unreviewed"* ]] \
  && ok "WT74 最終行に review=unreviewed が載る" || fail "WT74 (rc=$rc out=$out)"; teardown

# WT75: **レビュー役が起きていなければ何も足さない**（review_mode=off の既定を汚さない）。
setup; dn; msg; out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" != *"review="* ]] \
  && ok "WT75 review_mode=off には足さない" || fail "WT75 (rc=$rc out=$out)"; teardown

# WT76: ★ **「誰も待っていない」をディスクに残す。**この待機は 24 時間常駐するので外から
#      止められることがある（実測 2026-09-11、2 回連続: worker が同じマシンでテストを
#      並列に回し、ハーネスがメモリ逼迫で待機を停止した）。ack 前に落ちるので取りこぼしは
#      無いが、**起動し直す者が居なければ worker は永久に待つ。**気づく手がかりを残す。
setup; dn; msg; w >/dev/null 2>&1
[[ -s "$SD/wait.json" ]] \
  && [[ "$(jq -r '.pid' "$SD/wait.json")" =~ ^[0-9]+$ ]] \
  && [[ "$(jq -r '.beat' "$SD/wait.json")" =~ ^[0-9]+$ ]] \
  && [[ "$(jq -r '.window_ms' "$SD/wait.json")" =~ ^[0-9]+$ ]] \
  && ok "WT76 待機が鼓動を残す" || fail "WT76 ($(cat "$SD/wait.json" 2>/dev/null))"; teardown

# WT78: ★ **報告済みで記録前の worker を停止と読み違えない**（実測 2026-09-19、2 回）。
#       worker は worker_done を送った直後に Orca 側で 'succeeded' になるが、その
#       メッセージを drain するのは次の周回である。ここで 4 で降りると、**まだ働いている
#       兄弟タスクごと待機が落ちる。**receipt が来るまで数周だけ待つ。
setup; echo '{"ok":true,"result":{"worker":{"state":"succeeded"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 2 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" == *'has not arrived yet'* ]] \
  && ok "WT78 報告済み・記録前は数周待つ" || fail "WT78 (rc=$rc) $out"; teardown

# WT79: ★ **待つのは数周だけ。**worker_done を送れずに終わった worker は、猶予を使い切った
#       ところで今までどおり 4 になる（recovery の入口を塞がない）。
setup; echo '{"ok":true,"result":{"worker":{"state":"failed"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(ORCA_WAIT_SETTLE_GRACE=1 w 3 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"is 'failed'"* ]] \
  && ok "WT79 猶予を使い切れば 4" || fail "WT79 (rc=$rc) $out"; teardown

# ── ユーザーが止めた役（orca-stop.ts が stopped.json を書く）──
two_roles() {
  jq -nc '{integration_role:"design",roles:{
    design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:false},
    design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r",retained:false}}}' > "$SD/workers.json"
  mkdir -p "$SD/roles/design_review"
}
stop_role() { mkdir -p "$SD/roles/$1"; echo '{"stopped_at":1,"by":"user"}' > "$SD/roles/$1/stopped.json"; }
# 閉じた端末の worker-show は stopped を返す。reviewer（ctx_r）だけそう返す stub
reviewer_closed() {
  cat > "$ORCA_STUB_DIR/orchestration_worker-show.hook" <<'HOOK'
#!/usr/bin/env bash
case "$*" in *ctx_r*) s=stopped ;; *) s=active ;; esac
printf '{"ok":true,"result":{"worker":{"state":"%s"}}}\n' "$s" > "$ORCA_STUB_DIR/orchestration_worker-show"
HOOK
  chmod +x "$ORCA_STUB_DIR/orchestration_worker-show.hook"
}

# WT80: ★ **成果を載せる役を止めたら、そのタスクは失敗で終わる。**status は書きかけの
#      executing のまま残るので、status を待つと永久に終わらない。
setup; stop_role design
echo '{"ok":true,"result":{"worker":{"state":"stopped"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"role=design dispatch=ctx_x status_dir=$SD outcome=stopped"* \
   && "$out" == *"outcome=failed"* ]] \
  && ok "WT80 止めた作る役は失敗で終わる" || fail "WT80 (rc=$rc out=$out)"; teardown

# WT81: ★ **止めた役に worker-show をかけない。**閉じた端末は stopped を返し、かけると
#      まだ働いている兄弟ごと exit 4 で落ちる。
setup; two_roles; stop_role design_review; reviewer_closed
w 1 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT81 止めた役を health check にかけない" || fail "WT81 (rc=$rc)"; teardown

# WT82: reviewer を止めても、成果が成功ならタスクは成功。その役の行は outcome=stopped。
setup; two_roles; stop_role design_review; reviewer_closed; dn
echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
out=$(w 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"role=design_review dispatch=ctx_r status_dir=$SD outcome=stopped"* ]] \
  && ok "WT82 止めた reviewer はタスクを失敗にしない" || fail "WT82 (rc=$rc out=$out)"; teardown

# WT83: ★ **止めた役の merge_ready には返事をしない**（端末は閉じている）。batch は処理済みにする。
setup; two_roles; stop_role design_review; reviewer_closed
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dmr",count:1,messages:[
  {id:"mr",type:"merge_ready",subject:"merge_ready: n1",
   payload:({taskId:"task_r",dispatchId:"ctx_r"}|tojson),body:""}]}}' > "$ORCA_STUB_DIR/orchestration_check"
w 1 >/dev/null 2>&1
! tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" | grep -q '^completion-' \
  && grep -q -- '--ack dmr' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT83 止めた役の merge_ready に答えない" || fail "WT83"; teardown

# WT83b: ★ **閉じる直前に届いた worker_done は記録するが、retain しない。**閉じた端末に
#       retain をかけると失敗し、batch が永久に ack されない。
setup; two_roles; stop_role design_review; reviewer_closed
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dwd",count:1,messages:[
  {id:"wd",type:"worker_done",payload:({taskId:"task_r",dispatchId:"ctx_r",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
w 1 >/dev/null 2>&1
grep -q 'worker_done|task_r|ctx_r|succeeded' "$SD/received.json" 2>/dev/null \
  && ! grep 'worker-retain' "$ORCA_STUB_DIR/calls.log" | grep -q ctx_r \
  && grep -q -- '--ack dwd' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT83b 止めた役の receipt は記録し retain しない" || fail "WT83b"; teardown

# ── 停滞の検知（子は期限を持たないので、見つけるのは親である）──
old() { touch -t 202001010000 "$@"; }
STALL=3600

# WT84: 子が書くものが閾値を越えて変わらなければ exit 8。タスクと役を名指しする
setup; old "$SD/run.json" "$SD/roles/design/status.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"stalled task=$b status_dir=$SD idle_min="* \
   && "$out" == *"stalled_role task=$b role=design phase=executing terminal=term_w"* ]] \
  && ok "WT84 停滞で 8" || fail "WT84 (rc=$rc out=$out)"; teardown

# WT85: 動いているタスクは停滞ではない（run.json も status.json も新しい）
setup; ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT85 動いていれば 8 にしない" || fail "WT85 (rc=$rc)"; teardown

# WT86: ★ **親が書くファイルは変化に数えない。**数えると親の鼓動で常に「変化あり」になる
setup; old "$SD/run.json" "$SD/roles/design/status.json"
echo '[]' > "$SD/received.json"; echo '[]' > "$SD/questions.json"; echo 1 > "$SD/roles/design/.woken"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 8 ]] && ok "WT86 親の書き込みで時計を戻さない" || fail "WT86 (rc=$rc)"; teardown

# WT87: ★ **人を待っている役が居れば停滞ではない**（agentWait）。その時点を human.json に残す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
echo '{"ok":true,"result":{"worker":{"state":"active"},"observation":{"agentWait":{"evidence":"hook"}}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && "$(jq -r '.last_human_at' "$SD/human.json" 2>/dev/null)" =~ ^[0-9]+$ ]] \
  && ok "WT87 人の入力待ちで時計を戻す" || fail "WT87 (rc=$rc)"; teardown

# WT88: ★ **答えるのに何時間かかっても、呼び直した直後に停滞としない。**取り次ぎ済みの
#      質問を通した時点（人が答えた直後）で時計を戻す。
setup; old "$SD/run.json" "$SD/roles/design/status.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dq",count:1,messages:[
  {id:"q1",type:"question",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:"which?"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
echo '["q1"]' > "$SD/questions.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && -f "$SD/human.json" ]] && ok "WT88 答えた直後に停滞としない" || fail "WT88 (rc=$rc)"; teardown

# WT89: snoozed_at（「待ち続ける」と答えた時刻）から数え直す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
printf '{"snoozed_at":%s}\n' "$(date +%s)" > "$SD/stall.json"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT89 snooze から数え直す" || fail "WT89 (rc=$rc)"; teardown

# WT90: ★ **report は抜けずに記録する。同じ停滞を毎周出さない。**動き出したら記録を消す
setup; old "$SD/run.json" "$SD/roles/design/status.json"
err=$(ORCA_STALL_AFTER_SECONDS=$STALL node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits 3 \
        --timeout-ms 1 --on-stall report 2>&1 >/dev/null); rc=$?
n=$(grep -c 'stalled task=' <<<"$err")
d1=$(jq -r '.detected_at // empty' "$SD/stall.json" 2>/dev/null)
echo '{"status":"executing"}' > "$SD/roles/design/status.json"   # 動き出した
ORCA_STALL_AFTER_SECONDS=$STALL node "$P/bin/orca-wait.ts" --status-dir "$SD" --max-waits 1 \
  --timeout-ms 1 --on-stall report >/dev/null 2>&1
[[ "$rc" -eq 3 && "$n" -eq 1 && "$d1" =~ ^[0-9]+$ ]] \
  && jq -e 'has("detected_at") | not' "$SD/stall.json" >/dev/null 2>&1 \
  && ok "WT90 report は 1 回だけ記録し、動けば消す" || fail "WT90 (rc=$rc n=$n d1=$d1)"; teardown

# WT91: ★ **決着済みのタスクを停滞として報告しない**（兄弟がまだ動いているだけ）
setup; dn; echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
SD2=$(mktemp -d); mkdir -p "$SD2/roles/design"; cp "$SD/run.json" "$SD2/run.json"
echo '{"roles":{"design":{"terminal":"term_y","task":"task_y","dispatch":"ctx_y","retained":false}}}' > "$SD2/workers.json"
echo '{"status":"executing"}' > "$SD2/roles/design/status.json"
old "$SD/run.json" "$SD/roles/design/status.json" "$SD/received.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL node "$P/bin/orca-wait.ts" --status-dir "$SD" --status-dir "$SD2" \
        --max-waits 1 --timeout-ms 1 2>/dev/null); rc=$?
[[ "$rc" -eq 3 && "$out" != *stalled* ]] && ok "WT91 決着済みは停滞ではない" || fail "WT91 (rc=$rc out=$out)"
rm -rf "$SD2"; teardown

# WT92: 引数の検査。**rc 2 だけでは未知オプションと区別できない**ので、理由の文言も見る
setup
aerr=$(node "$P/bin/orca-wait.ts" --status-dir "$SD" --on-stall bogus 2>&1 >/dev/null); a=$?
berr=$(node "$P/bin/orca-wait.ts" --status-dir "$SD" --stall-after-min 0 2>&1 >/dev/null); b=$?
[[ "$a" -eq 2 && "$aerr" == *"--on-stall must be ask or report"* \
   && "$b" -eq 2 && "$berr" == *"--stall-after-min must be a positive integer"* ]] \
  && ok "WT92 停滞の引数を検査する" || fail "WT92 (a=$a aerr=$aerr b=$b berr=$berr)"; teardown

# WT93: env override 無しで `--stall-after-min` を受け付け、分を秒へ変換する
setup; old "$SD/run.json" "$SD/roles/design/status.json"
out=$(env -u ORCA_STALL_AFTER_SECONDS node "$P/bin/orca-wait.ts" --status-dir "$SD" \
        --max-waits 1 --timeout-ms 1 --stall-after-min 60 2>/dev/null); rc=$?
[[ "$rc" -eq 8 && "$out" == *"stalled task="* ]] \
  && ok "WT93 stall-after-min を分から秒へ変換して受け付ける" || fail "WT93 (rc=$rc out=$out)"; teardown

# ── phase_b=on の 2 段目と停滞（待機が読み直すのは message が来たときだけ）──
exec_json() {   # 2 段目 exec を記録した workers.json
  jq -nc '{integration_role:"exec",roles:{
    design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:true},
    exec:{terminal:"term_e",task:"task_e",dispatch:"ctx_e",retained:false}}}'
}
planner_only() {   # 計画役だけが起動済み（exec はまだ）
  jq -nc '{integration_role:"exec",roles:{design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x",retained:false}}}' \
    > "$SD/workers.json"
}

# WT94: ★ **待機の途中で足された exec も停滞の対象にする。**exec の最初の message までは期待集合が
#      読み直されないので、design が決着済みなだけでタスクを決着済みと数えていた。
#      決着済みの design は停滞の行に載せない
setup; planner_only; dn; echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
mkdir -p "$SD/roles/exec"; echo '{"status":"executing"}' > "$SD/roles/exec/status.json"
cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<HOOK
#!/usr/bin/env bash
case "\$*" in *--wait*) echo '$(exec_json)' > "$SD/workers.json" ;; esac
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
old "$SD/run.json" "$SD"/roles/*/status.json "$SD/received.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 3 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"stalled_role task=$b role=exec phase=executing terminal=term_e"* \
   && "$out" != *"role=design "* ]] \
  && ok "WT94 待機中に足された exec も停滞を見る" || fail "WT94 (rc=$rc out=$out)"; teardown

# WT95: ★ **Step 3.5 を飛ばしたら黙って 24 時間待たない。**成果を載せる役が起動されていない
#      タスクは決着していないので、閾値を越えたら知らせる（起動されていない役として名指しする）
setup; planner_only; dn; echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
old "$SD/run.json" "$SD/roles/design/status.json" "$SD/received.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"unstarted_role task=$b role=exec"* && "$out" != *"stalled_role"* ]] \
  && ok "WT95 起動されていない exec を停滞として知らせる" || fail "WT95 (rc=$rc out=$out)"; teardown

# WT96: ★ **計画役を止めたら、exec を待たずにタスクは失敗で終わる。**exec は起こされないので、
#      integration_role=exec の status を待つと永久に終わらない
setup; planner_only; stop_role design
echo '{"ok":true,"result":{"worker":{"state":"stopped"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 2 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"role=design dispatch=ctx_x status_dir=$SD outcome=stopped"* \
   && "$out" == *"outcome=failed"* ]] \
  && ok "WT96 止めた計画役は失敗で終わる" || fail "WT96 (rc=$rc out=$out)"; teardown

# WT97: 計画役が失敗して終えたら、exec は起こされない（Step 3.5）。同じくタスクは失敗で終わる
setup; planner_only; er; echo '["worker_done|task_x|ctx_x|failed"]' > "$SD/received.json"
out=$(w 2 2>/dev/null); rc=$?
[[ "$rc" -eq 5 && "$out" == *"outcome=failed"* ]] \
  && ok "WT97 失敗した計画役は exec を待たない" || fail "WT97 (rc=$rc out=$out)"; teardown

# WT98: ★ **止めた役を停滞の行に載せない。**載せると、止めたのに同じ役をまた尋ねる
setup; two_roles; stop_role design
echo '{"status":"executing"}' > "$SD/roles/design_review/status.json"
old "$SD/run.json" "$SD"/roles/*/status.json
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
[[ "$rc" -eq 8 && "$out" == *"role=design_review "* && "$out" != *"role=design "* ]] \
  && ok "WT98 止めた役は停滞の行に出ない" || fail "WT98 (rc=$rc out=$out)"; teardown

# WT99: brainstorm の design が書く spec.md も子の変化に数える
setup; old "$SD/run.json" "$SD/roles/design/status.json"; echo spec > "$SD/spec.md"
ORCA_STALL_AFTER_SECONDS=$STALL w >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 ]] && ok "WT99 spec.md の変化で停滞としない" || fail "WT99 (rc=$rc)"; teardown

# WT100: ★ **決着済みの reviewer でも、依頼側がまだ待っていれば停滞の行に載せる。**verdict を
#       届けられずに終えた reviewer を止める（依頼側へ review-skipped を送る）選択肢が、
#       この行からしか作られない
setup; two_roles; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
old "$SD/run.json" "$SD/roles/design/status.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"stalled_role task=$b role=design_review "* \
   && "$out" == *"stalled_role task=$b role=design "* ]] \
  && ok "WT100 決着済みの reviewer も依頼側が待つ間は載せる" || fail "WT100 (rc=$rc out=$out)"; teardown

# WT101: 計画役がまだ働いている間は unstarted_role を出さない（Step 3.5 はまだ早い）
setup; planner_only; old "$SD/run.json" "$SD/roles/design/status.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
[[ "$rc" -eq 8 && "$out" == *"role=design phase=executing"* && "$out" != *unstarted_role* ]] \
  && ok "WT101 計画役が働く間は unstarted_role を出さない" || fail "WT101 (rc=$rc out=$out)"; teardown

# WT102: ★ **置き換えた試行（superseded）からの message で batch を止めない。**orca-recover が --retry-of で
#        置き換えた dispatch は、役の `dispatch` から外れて `superseded` に残る。その dispatch の message が
#        あとから届いても未知として batch を詰まらせない（処理済みとして通し、receipt にはしない）
setup
jq -c '.roles.design.superseded = ["ctx_old"]' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:2,messages:[
  {id:"o1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_old",outcome:"failed"}|tojson),body:""},
  {id:"m1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
dn
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *'superseded'* ]] \
  && [[ "$(grep -c -- '--ack d1' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(jq -c . "$SD/received.json")" == '["worker_done|task_x|ctx_x|succeeded"]' ]] \
  && ok "WT102 superseded の message は batch を止めない" || fail "WT102 (rc=$rc out=$out)"; teardown

# WT103: ★ **待機が読み込んだあとで置き換えられた試行の message を、現行として扱わない。**待機の途中で
#        orca-recover が dispatch を置き換え（古いものを `superseded` へ移し）、そのあとで古い試行の merge_ready /
#        worker_done が届いても、返信も receipt も retain もしない。batch は処理済みとして通し、新しい試行を待ち続ける
setup
cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<HOOK
#!/usr/bin/env bash
case " \$* " in *" --wait "*) ;; *) exit 0 ;; esac
[[ -e "$ORCA_STUB_DIR/replaced" ]] && exit 0
: > "$ORCA_STUB_DIR/replaced"
jq -c '.roles.design.dispatch = "ctx_new" | .roles.design.superseded = ["ctx_x"]' "$SD/workers.json" > "$SD/w" \
  && mv "$SD/w" "$SD/workers.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:2,messages:[
  {id:"mr",type:"merge_ready",subject:"merge_ready: n1",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:""},
  {id:"o1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"failed"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
out=$(w 1 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" == *'superseded'* ]] \
  && [[ "$(grep -c -- '--ack d1' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ! grep -qE '^orchestration send|worker-retain' "$ORCA_STUB_DIR/calls.log" \
  && [[ ! -e "$SD/received.json" ]] \
  && ok "WT103 待機中に置き換えられた試行の message は現行として扱わない" || fail "WT103 (rc=$rc out=$out)"; teardown

# WT103b: 置換済みの message を通した後は期待集合を読み直し、新しい dispatch の health を見る。
setup
cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<HOOK
#!/usr/bin/env bash
[[ -e "$ORCA_STUB_DIR/replaced" ]] && exit 0
: > "$ORCA_STUB_DIR/replaced"
jq -c '.roles.design.dispatch = "ctx_new" | .roles.design.superseded = ["ctx_x"]' "$SD/workers.json" > "$SD/w" \
  && mv "$SD/w" "$SD/workers.json"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"d1",count:1,messages:[
  {id:"o1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"failed"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
HOOK
cat > "$ORCA_STUB_DIR/orchestration_worker-show.hook" <<HOOK
#!/usr/bin/env bash
case " \$* " in
  *" --dispatch ctx_x "*) echo '{"ok":true,"result":{"worker":{"state":"failed"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show" ;;
  *) echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show" ;;
esac
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook" "$ORCA_STUB_DIR/orchestration_worker-show.hook"
out=$(ORCA_WAIT_SETTLE_GRACE=1 w 4 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" == *'superseded'* && "$out" != *"the worker for dispatch 'ctx_x' is 'failed'"* ]] \
  && [[ ! -e "$SD/received.json" ]] \
  && ok "WT103b 置換後は新しい dispatch の health を見る" || fail "WT103b (rc=$rc out=$out)"; teardown

# WT104: ★ retain 中に workers.json が読めなくなっても、空の記録で上書きせず batch を ack しない。
setup; dn; msg
cat > "$ORCA_STUB_DIR/orchestration_worker-retain.hook" <<HOOK
#!/usr/bin/env bash
: > "$SD/workers.json"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_worker-retain.hook"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *'could not record the retention'* && ! -s "$SD/workers.json" ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT104 読めない記録を上書きせず ack しない" || fail "WT104 (rc=$rc out=$out)"; teardown

# WT105: ★ 読めない workers.json は superseded ではない。receipt 無しで ack してはならない。
setup; dn; msg
cat > "$ORCA_STUB_DIR/orchestration_check.hook" <<HOOK
#!/usr/bin/env bash
case " \$* " in *" --ack "*) ;; *) : > "$SD/workers.json" ;; esac
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_check.hook"
out=$(w 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *'cannot read workers.json'* && ! -e "$SD/received.json" ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && ok "WT105 読めない記録を superseded と扱わない" || fail "WT105 (rc=$rc out=$out)"; teardown

# WT106: 読めない findings を verdict が有るものとして受理しない。
reviewed_setup; mkdir "$SD/review/code-round-1-findings.md"
jq -nc '{ok:true,result:{runId:"run_x",deliveryId:"dm",count:1,messages:[
  {id:"mr",type:"merge_ready",subject:"merge_ready: nx",payload:({taskId:"task_x",dispatchId:"ctx_er"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(w 2>&1)
[[ "$out" == *'has no VERDICT line'* && "$out" == *'back for remediation'* && "$out" != *'accepted exec_review'* ]] \
  && ok "WT106 読めない findings は差し戻す" || fail "WT106 (out=$out)"; teardown

# ── Orca が start_unknown と言う worker（2026-09-24、influencer-platform）────────────────────────────
# ★ Orca は依頼を入力したが agent のターン開始を観測できなかった。生死のどちらの証拠でもなく、動いている reviewer にも
#   出続けた。以前はここで exit 4 になり、Step 3 が起動直後に止まった
unconfirmed_show() {   # $1 = worker-show が出す端末
  jq -nc --arg t "$1" '{ok:true,result:{worker:{state:"start_unknown",stage:"turn_start_unobserved",agentTerminalHandle:$t},
    dispatch:{status:"pending"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
}
unrecorded() {   # 起動が終わらなかった役の記録（端末なし・start_incomplete）
  jq -c '.roles.design.terminal = "" | .roles.design.start_incomplete = true' "$SD/workers.json" > "$SD/w" \
    && mv "$SD/w" "$SD/workers.json"
}

# WT107: ★ **start_unknown では待ち続け、dispatch ごとに 1 回だけ言う。**毎周言うと 24 時間で 288 行になる
setup; unconfirmed_show term_w
out=$(w 2 2>&1); rc=$?
[[ "$rc" -eq 3 && "$(grep -c "is 'start_unknown'" <<<"$out")" -eq 1 ]] \
  && ok "WT107 start_unknown では待ち続け、1 回だけ言う" || fail "WT107 (rc=$rc out=$out)"; teardown

# WT108: ★ **記録に端末が無ければ Orca が見せている端末で埋める。**start_incomplete の印は外さない（外すのは
#        ユーザーの判断 = orca-recover.ts --adopt）。起動が終わらなかった役には回復の 1 行も添える
setup; unrecorded; unconfirmed_show term_u
out=$(w 1 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" == *'orca-recover.ts --status-dir'* && "$out" == *'--role design'* ]] \
  && jq -e '.roles.design | .terminal == "term_u" and .start_incomplete == true and .dispatch == "ctx_x"' \
       "$SD/workers.json" >/dev/null \
  && ok "WT108 記録に無い端末を埋め、印は外さない" || fail "WT108 (rc=$rc out=$out)"; teardown

# WT108b: 記録にある端末は上書きしない
setup; echo '{"ok":true,"result":{"worker":{"state":"active","agentTerminalHandle":"term_u"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 1 2>&1)
[[ "$(jq -r '.roles.design.terminal' "$SD/workers.json")" == term_w && "$out" != *'recorded terminal'* ]] \
  && ok "WT108b 記録にある端末は上書きしない" || fail "WT108b (out=$out)"; teardown

# WT108c: 走っている worker でも、記録に端末が無ければ埋める（Orca が後から動いていると認めた起動）
setup; unrecorded; echo '{"ok":true,"result":{"worker":{"state":"active","agentTerminalHandle":"term_u"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
w 1 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && "$(jq -r '.roles.design.terminal' "$SD/workers.json")" == term_u ]] \
  && ok "WT108c 走っている worker の端末も埋める" || fail "WT108c (rc=$rc)"; teardown

# WT109: ★ **死んだ start_unknown の worker は停滞（exit 8）で見つかる。**埋めた端末を stalled_role 行が名指しするので、
#        Step 3 はその画面を読める
setup; unrecorded; unconfirmed_show term_u; old "$SD/run.json" "$SD/roles/design/status.json"
out=$(ORCA_STALL_AFTER_SECONDS=$STALL w 2>/dev/null); rc=$?
b=$(basename "$SD")
[[ "$rc" -eq 8 && "$out" == *"stalled_role task=$b role=design phase=executing terminal=term_u"* ]] \
  && ok "WT109 死んだ start_unknown は停滞として埋めた端末を名指しする" || fail "WT109 (rc=$rc out=$out)"; teardown

# WT110: 緩めたのは start_unknown だけ。outcome_unknown などは今までどおり 4
setup; echo '{"ok":true,"result":{"worker":{"state":"outcome_unknown"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 3 2>&1); rc=$?
[[ "$rc" -eq 4 && "$out" == *"is 'outcome_unknown'"* ]] \
  && ok "WT110 outcome_unknown は今までどおり 4" || fail "WT110 (rc=$rc out=$out)"; teardown

# WT111: ★ **印の無い旧形式の記録でも、端末を埋めたあと起動が終わらなかった役のまま残す**（round 1 のレビュー F2）。
#        旧形式は「端末なし・status が starting」で読まれる（lib/dispatch.ts）ので、端末だけ埋めると起動が終わったことに
#        なり、--adopt / --restart が効かなくなる。埋める書き込みで印を明示する（引き受ける側は RC30b がこの状態から見る）
setup
jq -c '.roles.design.terminal = ""' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
echo '{"status":"starting"}' > "$SD/roles/design/status.json"
unconfirmed_show term_u
out=$(w 1 2>&1); rc=$?
[[ "$rc" -eq 3 && "$out" == *'orca-recover.ts --status-dir'* && "$out" == *'--role design'* ]] \
  && jq -e '.roles.design | .terminal == "term_u" and .start_incomplete == true' "$SD/workers.json" >/dev/null \
  && ok "WT111 旧形式の起動未完了は端末を埋めても起動未完了のまま" || fail "WT111 (rc=$rc out=$out)"; teardown

# WT112: ★ **人を待っている worker でも、端末を埋めて start_unknown を 1 回だけ言う**（round 1 のレビュー F3）。
#        agentWait で先に読み飛ばすと、入力待ちの start_unknown の worker の端末がいつまでも埋まらない。
#        人を待つ間は停滞と数えない（human.json）のは今までどおり
setup; unrecorded
jq -nc '{ok:true,result:{worker:{state:"start_unknown",agentTerminalHandle:"term_u"},observation:{agentWait:"prompt"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
out=$(w 2 2>&1); rc=$?
[[ "$rc" -eq 3 && "$(grep -c "is 'start_unknown'" <<<"$out")" -eq 1 && -f "$SD/human.json" ]] \
  && jq -e '.roles.design.terminal == "term_u"' "$SD/workers.json" >/dev/null \
  && ok "WT112 人を待つ start_unknown も端末を埋め、1 回だけ言う" || fail "WT112 (rc=$rc out=$out)"; teardown

# WT112b: 走っていて人を待っている worker も、記録に端末が無ければ埋める
setup; unrecorded
echo '{"ok":true,"result":{"worker":{"state":"idle","agentTerminalHandle":"term_u"},"observation":{"agentWait":"prompt"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
w 1 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 3 && "$(jq -r '.roles.design.terminal' "$SD/workers.json")" == term_u ]] \
  && ok "WT112b 人を待つ live の worker の端末も埋める" || fail "WT112b (rc=$rc)"; teardown
echo "---"; echo "failures: $fails"; exit "$fails"
