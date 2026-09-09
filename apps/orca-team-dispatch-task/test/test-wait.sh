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
    {id:"q1",type:"question",payload:({taskId:"task_x",dispatchId:"ctx_x"}|tojson),body:"?"},
    {id:"m1",type:"worker_done",payload:({taskId:"task_x",dispatchId:"ctx_x",outcome:"succeeded"}|tojson),body:""}]}}' \
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
setup; bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 0 >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 ]] && ok "WT19b max-waits を検証" || fail "WT19b (rc=$rc)"; teardown
setup; bash "$P/bin/orca-wait.sh" --status-dir "$SD" --timeout-ms nope >/dev/null 2>&1; rc=$?
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
w2() { bash "$P/bin/orca-wait.sh" --status-dir "$SD" --status-dir "$SD2" \
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

echo "---"; echo "failures: $fails"; exit "$fails"
