#!/usr/bin/env bash
# 完了の二相コミット（spec 10）。**成果が無いのに受理しないこと**と、
# **crash から再入しても二重に進めないこと**が全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
C="$P/skills/orca-team-dispatch-task/scripts/completion.sh"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() { D=$(mktemp -d); }
teardown() { rm -rf "$D"; }
ph() { bash "$C" --role-dir "$D" phase; }

# CM1: ★ **prepared 直後の crash から再入しても nonce を振り直さない。**振り直すと、
#      飛んでいる merge_ready への accepted が照合で落ちて**永久に進めなくなる**。
setup
n1=$(bash "$C" --role-dir "$D" prepare); n2=$(bash "$C" --role-dir "$D" prepare)
[[ -n "$n1" && "$n1" == "$n2" && "$(ph)" == prepared ]] \
  && ok "CM1 prepare は冪等で nonce を振り直さない" || fail "CM1 ($n1/$n2)"
teardown

# CM2: 相は前進のみ。送信済みから prepared へ戻らない。
setup
bash "$C" --role-dir "$D" prepare >/dev/null
bash "$C" --role-dir "$D" sent
bash "$C" --role-dir "$D" prepare >/dev/null 2>&1
[[ "$(ph)" == merge_ready_sent ]] && ok "CM2 相は後退しない" || fail "CM2 ($(ph))"
teardown

# CM3: ★ **nonce が一致しない accepted で受理しない。**古い試行や別 generation の
#      受理を、今の完了の受理として使わない。
setup
n=$(bash "$C" --role-dir "$D" prepare); bash "$C" --role-dir "$D" sent
bash "$C" --role-dir "$D" accept --nonce "not-$n" >/dev/null 2>&1
[[ $? -ne 0 && "$(ph)" == merge_ready_sent ]] || fail "CM3 不一致で進めた"
bash "$C" --role-dir "$D" accept --nonce "$n"
[[ "$(ph)" == accepted ]] && ok "CM3 nonce 照合で受理を分ける" || fail "CM3 ($(ph))"
teardown

# CM4: accepted の replay は no-op（10-3 の「accepted 受領後・done 前」の再入）。
setup
n=$(bash "$C" --role-dir "$D" prepare); bash "$C" --role-dir "$D" sent
bash "$C" --role-dir "$D" accept --nonce "$n"
bash "$C" --role-dir "$D" accept --nonce "$n"; rc=$?
[[ "$rc" -eq 0 && "$(ph)" == accepted ]] && ok "CM4 accepted の replay は no-op" || fail "CM4"
teardown

# CM5: settled 後の accepted も no-op（「settled 書き込み後、ack 前」の再入）。
setup
n=$(bash "$C" --role-dir "$D" prepare); bash "$C" --role-dir "$D" sent
bash "$C" --role-dir "$D" accept --nonce "$n"; bash "$C" --role-dir "$D" settle
bash "$C" --role-dir "$D" accept --nonce "$n"; rc=$?
[[ "$rc" -eq 0 && "$(ph)" == settled ]] && ok "CM5 settled 後の replay は no-op" || fail "CM5"
teardown

# CM6: ★ **受理していないものを settle できない。**worker_done を送っていない完了を
#      「終わった」と記録すると、親は永久に待つ。
setup
bash "$C" --role-dir "$D" prepare >/dev/null
bash "$C" --role-dir "$D" settle >/dev/null 2>&1
[[ $? -ne 0 && "$(ph)" == prepared ]] && ok "CM6 accepted を経ずに settle しない" || fail "CM6"
teardown

# CM7: 記録が無いところで accept しない（何も無いのに受理を作らない）。
setup
bash "$C" --role-dir "$D" accept --nonce whatever >/dev/null 2>&1
[[ $? -ne 0 && -z "$(ph)" ]] && ok "CM7 記録が無ければ受理しない" || fail "CM7"
teardown

# --- 親側の検証（相 3）---
# ★ ここを緩めると、**成果が無いのに受理して端末を閉じ、欠落に誰も気づかない**。
vsetup() {
  SD=$(mktemp -d); mkdir -p "$SD/roles/design" "$SD/roles/exec" "$SD/review"
  printf '{"run_id":"r","parent_handle":"p","repo_root":"/tmp"}\n' > "$SD/run.json"
  jq -nc '{integration_role:"design",roles:{design:{task:"t",dispatch:"c"}}}' > "$SD/workers.json"
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  echo '{"ok":true,"result":{"runId":"r","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
  echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
}
vteardown() { rm -rf "$SD" "$ORCA_STUB_DIR"; unset ORCA_BIN ORCA_STUB_DIR; }
# merge_ready を 1 通投げて、親が accepted / remediation のどちらを返すかを見る
merge_ready_msg() {   # $1=nonce [$2=task $3=dispatch]
  jq -nc --arg n "$1" --arg t "${2:-t}" --arg c "${3:-c}" \
    '{ok:true,result:{runId:"r",deliveryId:"dm",count:1,messages:[
      {id:"mr",type:"merge_ready",payload:({taskId:$t,dispatchId:$c,nonce:$n}|tojson),body:""}]}}' \
    > "$ORCA_STUB_DIR/orchestration_check"
}
sent_subject() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" 2>/dev/null | grep -E '^completion-(accepted|remediation): ' | tail -1; }
wait_once() { bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1; }

# CM8: ★ **result.md が無ければ差し戻す。**成果の無い完了を受理しない。
vsetup; merge_ready_msg n1; wait_once
[[ "$(sent_subject)" == 'completion-remediation: n1' ]] \
  && ok "CM8 成果が無ければ差し戻す" || fail "CM8 ($(sent_subject))"
vteardown

# CM9: result.md があれば受理する。
vsetup; printf 'did it\n' > "$SD/roles/design/result.md"; merge_ready_msg n2; wait_once
[[ "$(sent_subject)" == 'completion-accepted: n2' ]] \
  && ok "CM9 成果があれば受理する" || fail "CM9 ($(sent_subject))"
vteardown

# CM10: ★ **計画役の design は plan.md で判定する。**実装役が別に居るとき、design の
#       result.md ではなく計画の実在が受理の条件である。
vsetup
# ★ 役ごとに違う (task, dispatch) を持たせる。同じにすると待機が開始時に弾く（WT35）
jq -c '.integration_role = "exec"
       | .roles.design = {task:"t1",dispatch:"c1"}
       | .roles.exec   = {task:"t2",dispatch:"c2"}' "$SD/workers.json" > "$SD/w"
mv "$SD/w" "$SD/workers.json"
printf 'did it\n' > "$SD/roles/design/result.md"
merge_ready_msg n3 t1 c1; wait_once
[[ "$(sent_subject)" == 'completion-remediation: n3' ]] || fail "CM10 plan 無しで受理した"
printf '# plan\n' > "$SD/plan.md"; merge_ready_msg n4 t1 c1; wait_once
[[ "$(sent_subject)" == 'completion-accepted: n4' ]] \
  && ok "CM10 計画役は plan.md で判定する" || fail "CM10 ($(sent_subject))"
vteardown

# CM11: ★ **review 役を例外にしない**（spec 10-4）。例外にすると findings の受理時点が
#       未定義のまま端末が閉じられ、欠落に誰も気づかない。
vsetup
jq -c '.roles.design = {task:"t1",dispatch:"c1"}
       | .roles.design_review = {task:"t2",dispatch:"c2"}' "$SD/workers.json" > "$SD/w"
mv "$SD/w" "$SD/workers.json"
mkdir -p "$SD/roles/design_review"
printf 'findings without a verdict\n' > "$SD/review/plan-round-1-findings.md"
merge_ready_msg n5 t2 c2; wait_once
[[ "$(sent_subject)" == 'completion-remediation: n5' ]] || fail "CM11 VERDICT 無しで受理した"
printf 'looks fine\n\nVERDICT: approved\n' > "$SD/review/plan-round-1-findings.md"
merge_ready_msg n6 t2 c2; wait_once
[[ "$(sent_subject)" == 'completion-accepted: n6' ]] \
  && ok "CM11 review 役も VERDICT で判定する" || fail "CM11 ($(sent_subject))"
vteardown

# CM12: nonce の無い merge_ready は処理できない（ack せずに止まる）。
vsetup
jq -nc '{ok:true,result:{runId:"r",deliveryId:"dm",count:1,messages:[
  {id:"mr",type:"merge_ready",payload:({taskId:"t",dispatchId:"c"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
rc=$?
[[ "$rc" -ne 0 ]] && [[ "$(grep -cE '^orchestration check .*--ack' "$ORCA_STUB_DIR/calls.log")" -eq 0 ]] \
  && ok "CM12 nonce の無い merge_ready は ack しない" || fail "CM12 (rc=$rc)"
vteardown

# CM13: 知らない dispatch の merge_ready も ack しない（routing できない）。
vsetup
jq -nc '{ok:true,result:{runId:"r",deliveryId:"dm",count:1,messages:[
  {id:"mr",type:"merge_ready",payload:({taskId:"other",dispatchId:"nope",nonce:"n"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
[[ $? -ne 0 ]] && [[ "$(grep -cE '^orchestration check .*--ack' "$ORCA_STUB_DIR/calls.log")" -eq 0 ]] \
  && ok "CM13 知らない dispatch の merge_ready は ack しない" || fail "CM13"
vteardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
