#!/usr/bin/env bash
# 完了の二相コミット（spec 10）。**成果が無いのに受理しないこと**と、
# **crash から再入しても二重に進めないこと**が全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
C="$P/skills/orca-team-dispatch-task/scripts/completion.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() { D=$(mktemp -d); }
teardown() { rm -rf "$D"; }
ph() { node "$C" --role-dir "$D" phase; }

# CM1: ★ **prepared 直後の crash から再入しても nonce を振り直さない。**振り直すと、
#      飛んでいる merge_ready への accepted が照合で落ちて**永久に進めなくなる**。
setup
n1=$(node "$C" --role-dir "$D" prepare); n2=$(node "$C" --role-dir "$D" prepare)
[[ -n "$n1" && "$n1" == "$n2" && "$(ph)" == prepared ]] \
  && ok "CM1 prepare は冪等で nonce を振り直さない" || fail "CM1 ($n1/$n2)"
teardown

# CM2: 相は前進のみ。送信済みから prepared へ戻らない。
setup
node "$C" --role-dir "$D" prepare >/dev/null
node "$C" --role-dir "$D" sent
node "$C" --role-dir "$D" prepare >/dev/null 2>&1
[[ "$(ph)" == merge_ready_sent ]] && ok "CM2 相は後退しない" || fail "CM2 ($(ph))"
teardown

# CM3: ★ **nonce が一致しない accepted で受理しない。**古い試行や別 generation の
#      受理を、今の完了の受理として使わない。
setup
n=$(node "$C" --role-dir "$D" prepare); node "$C" --role-dir "$D" sent
node "$C" --role-dir "$D" accept --nonce "not-$n" >/dev/null 2>&1
[[ $? -ne 0 && "$(ph)" == merge_ready_sent ]] || fail "CM3 不一致で進めた"
node "$C" --role-dir "$D" accept --nonce "$n"
[[ "$(ph)" == accepted ]] && ok "CM3 nonce 照合で受理を分ける" || fail "CM3 ($(ph))"
teardown

# CM4: accepted の replay は no-op（10-3 の「accepted 受領後・done 前」の再入）。
setup
n=$(node "$C" --role-dir "$D" prepare); node "$C" --role-dir "$D" sent
node "$C" --role-dir "$D" accept --nonce "$n"
node "$C" --role-dir "$D" accept --nonce "$n"; rc=$?
[[ "$rc" -eq 0 && "$(ph)" == accepted ]] && ok "CM4 accepted の replay は no-op" || fail "CM4"
teardown

# CM5: settled 後の accepted も no-op（「settled 書き込み後、ack 前」の再入）。
setup
n=$(node "$C" --role-dir "$D" prepare); node "$C" --role-dir "$D" sent
node "$C" --role-dir "$D" accept --nonce "$n"; node "$C" --role-dir "$D" settle
node "$C" --role-dir "$D" accept --nonce "$n"; rc=$?
[[ "$rc" -eq 0 && "$(ph)" == settled ]] && ok "CM5 settled 後の replay は no-op" || fail "CM5"
teardown

# CM6: ★ **受理していないものを settle できない。**worker_done を送っていない完了を
#      「終わった」と記録すると、親は永久に待つ。
setup
node "$C" --role-dir "$D" prepare >/dev/null
node "$C" --role-dir "$D" settle >/dev/null 2>&1
[[ $? -ne 0 && "$(ph)" == prepared ]] && ok "CM6 accepted を経ずに settle しない" || fail "CM6"
teardown

# CM7: 記録が無いところで accept しない（何も無いのに受理を作らない）。
setup
node "$C" --role-dir "$D" accept --nonce whatever >/dev/null 2>&1
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
# ★ nonce は **subject** で運ぶ。`--payload` は便宜フラグに上書きされるので届かない（実測）。
merge_ready_msg() {   # $1=nonce [$2=task $3=dispatch]
  jq -nc --arg n "$1" --arg t "${2:-t}" --arg c "${3:-c}" \
    '{ok:true,result:{runId:"r",deliveryId:"dm",count:1,messages:[
      {id:"mr",type:"merge_ready",subject:("merge_ready: " + $n),
       payload:({taskId:$t,dispatchId:$c}|tojson),body:""}]}}' \
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

# CM14: ★ **`reconcile` は親専用の別経路。**「Orca 側が既に terminal」という外部の証拠を
#       持つ者だけが使う。worker の `settle` を緩めるのではなく別の口にしてあるのは、
#       **証拠の出どころが違う**からである（worker は自分の受理を知らずに settled を
#       書いてはならない = CM6）。
setup
node "$C" --role-dir "$D" prepare >/dev/null
node "$C" --role-dir "$D" settle >/dev/null 2>&1
[[ $? -ne 0 && "$(ph)" == prepared ]] || fail "CM14 settle が緩んでいる"
node "$C" --role-dir "$D" reconcile
[[ "$(ph)" == settled ]] && ok "CM14 reconcile だけが外部の証拠で settled にできる" || fail "CM14"
teardown

# CM15: 記録が無いところで reconcile しない（何も無いのに完了を作らない）。
setup
node "$C" --role-dir "$D" reconcile >/dev/null 2>&1
[[ $? -ne 0 && -z "$(ph)" ]] && ok "CM15 記録が無ければ reconcile しない" || fail "CM15"
teardown

# CM16: ★ **payload に入った nonce も後方互換で読む。**正本は subject だが、payload に
#       入って届く経路が将来できたときに落とさない。
vsetup; printf 'did it\n' > "$SD/roles/design/result.md"
jq -nc '{ok:true,result:{runId:"r",deliveryId:"dm",count:1,messages:[
  {id:"mr",type:"merge_ready",subject:"ready: something",
   payload:({taskId:"t",dispatchId:"c",nonce:"pn"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
wait_once
[[ "$(sent_subject)" == 'completion-accepted: pn' ]] \
  && ok "CM16 payload の nonce も読む" || fail "CM16 ($(sent_subject))"
vteardown

# ── await（相 4 の worker 側）─────────────────────────────────────────────
# ★ **ここが「途中で止まる」の本体だった。**旧手順は merge_ready を送ったあと
#   「End your turn here」と worker にターンを閉じさせていたが、`orchestration send` は
#   メールボックスに入れるだけでアイドルな worker を起こさない（実測 2026-09-10)。
#   nonce の照合を目視から script へ移し、**待ち続ける口**をここに置く。
asetup() {
  D=$(mktemp -d)
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  export ORCA_TERMINAL_HANDLE=term_w
  echo '{"ok":true,"result":{"count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
  N=$(node "$C" --role-dir "$D" prepare); node "$C" --role-dir "$D" sent
}
ateardown() { rm -rf "$D" "$ORCA_STUB_DIR"; unset ORCA_STUB_DIR ORCA_BIN ORCA_TERMINAL_HANDLE; }
reply() {   # $1=accepted|remediation $2=nonce [$3=body]
  jq -nc --arg s "completion-$1: $2" --arg b "${3:-}" \
    '{ok:true,result:{count:1,messages:[{id:"r1",type:"status",subject:$s,body:$b}]}}' \
    > "$ORCA_STUB_DIR/orchestration_check"
}
aw() { node "$C" --role-dir "$D" await; }

# CM17: 自分の nonce の accepted を受けたら accepted と出し、相も accepted へ進める。
asetup; reply accepted "$N"; out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == "accepted" && "$(node "$C" --role-dir "$D" phase)" == accepted ]] \
  && ok "CM17 accepted を受けて相が進む" || fail "CM17 (rc=$rc out=$out)"
ateardown

# CM18: remediation は本文を出し、相は merge_ready_sent のまま（C からやり直す）。
asetup; reply remediation "$N" 'result.md is missing'; out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == remediation* && "$out" == *"result.md is missing"* \
   && "$(node "$C" --role-dir "$D" phase)" == merge_ready_sent ]] \
  && ok "CM18 remediation は相を進めない" || fail "CM18 (rc=$rc out=$out)"
ateardown

# CM19: ★ **他人の nonce で受理しない。**古い試行の accepted を今の完了に使わない。
asetup; reply accepted "not-my-nonce"; out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting && "$(node "$C" --role-dir "$D" phase)" == merge_ready_sent ]] \
  && ok "CM19 別 nonce の accepted は待機のまま" || fail "CM19 (rc=$rc out=$out)"
ateardown

# CM20: ★ **空振りは「まだ来ていない」であって「来ない」ではない。**waiting を返して
#      呼び直させる。ここを give-up にしたのが旧版の停止だった。
asetup; out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM20 空振りは waiting" || fail "CM20 (rc=$rc out=$out)"
ateardown

# CM20b: 無関係な message（heartbeat など）は読み飛ばして waiting。
asetup
jq -nc '{ok:true,result:{count:1,messages:[{id:"h",type:"heartbeat",subject:"tick",body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(aw 2>/dev/null)
[[ "$out" == waiting ]] && ok "CM20b 無関係な message は読み飛ばす" || fail "CM20b ($out)"
ateardown

# CM21: ★ **--peek で読み、--ack を絶対に付けない。**cursor は自分のものではない。
asetup; aw >/dev/null 2>&1
a=$(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log")
grep -qxF -- '--peek' <<<"$a" && ! grep -qxF -- '--ack' <<<"$a" \
  && grep -qxF 'term_w' <<<"$a" && ok "CM21 --peek のみで読む" || fail "CM21"
ateardown

# CM22: ★ **待機に期限を置かない。**worker は待っている相手の事情（人の回答待ちなど）を
#      知らないので、「来ない」を判断させない。`sent` は期限を記録しない。
asetup
[[ -z "$(jq -r '.await_deadline // empty' "$D/completion.json")" ]] \
  && ok "CM22 sent は期限を記録しない" || fail "CM22"
ateardown

# CM22b: 旧版が書いた期限が残っていても expired を返さない（待ち続ける）。
asetup
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM22b 古い期限では降りない" || fail "CM22b (rc=$rc out=$out)"
ateardown

# CM23: 旧版の期限が残っていても、届いている accepted は受理する。
asetup; reply accepted "$N"
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(aw 2>/dev/null)
[[ "$out" == accepted ]] && ok "CM23 古い期限があっても accepted を拾う" || fail "CM23 ($out)"
ateardown

# CM24: transport が壊れているのは「返事が無い」とは違う。1 で返して待機と区別する。
asetup; echo 1 > "$ORCA_STUB_DIR/orchestration_check.rc"
aw >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "CM24 transport 障害は 1" || fail "CM24 (rc=$rc)"
ateardown

# CM25: merge_ready を送る前の await は使用法の誤り（相が違う）。
asetup; printf '%s\n' '{"phase":"prepared","generation":1,"nonce":"n"}' > "$D/completion.json"
aw >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "CM25 送信前の await は 1" || fail "CM25 (rc=$rc)"
ateardown

# CM26: ORCA_TERMINAL_HANDLE が無ければ読みに行かない（Orca に推測させない）。
asetup; unset ORCA_TERMINAL_HANDLE; : > "$ORCA_STUB_DIR/calls.log"
aw >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "CM26 handle が無ければ読まない" || fail "CM26 (rc=$rc)"
ateardown

# CM27: ★ **`waiter_exists` は transport の障害ではない。**1 つの Run で待機が競合すると
#       Orca は待ちを拒むが、返事が来ないわけではない（実測 2026-09-11: exec がこれを
#       恒久的な失敗と読み、レビュー無しで成果を差し出した）。waiting を返して呼び直させる。
asetup
printf '%s\n' '{"ok":false,"error":{"code":"waiter_exists","message":"a waiter is already active"}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(ORCA_WAITER_RETRY_SECONDS=0 aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM27 waiter_exists は waiting" || fail "CM27 (rc=$rc out=$out)"
ateardown

# CM27b: waiter_exists が続き、旧版の期限を越えていても waiting を返す（期限で降りない）。
asetup
printf '%s\n' '{"ok":false,"error":{"code":"waiter_exists","message":"a waiter is already active"}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
upd=$(jq -c --argjson t "$(( $(date +%s) - 1 ))" '.await_deadline = $t' "$D/completion.json")
printf '%s\n' "$upd" > "$D/completion.json"
out=$(ORCA_WAITER_RETRY_SECONDS=0 aw 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == waiting ]] && ok "CM27b 期限では降りない" || fail "CM27b (rc=$rc out=$out)"
ateardown

# CM28: zsh から呼んでも同じ結果になる（設計 3-5。worker の端末は zsh のことがある）
if command -v zsh >/dev/null 2>&1; then
  setup
  n1=$(zsh -c 'node "$1" --role-dir "$2" prepare' zsh "$C" "$D" 2>/dev/null); zrc=$?
  n2=$(bash -c 'node "$1" --role-dir "$2" nonce' bash "$C" "$D" 2>/dev/null)
  [[ "$zrc" -eq 0 && -n "$n1" && "$n1" == "$n2" && "$(ph)" == prepared ]] \
    && ok "CM28 zsh から呼んでも同じ結果" || fail "CM28 ($zrc $n1/$n2)"
  teardown
else
  echo "SKIP: CM28 zsh が無い"
fi
echo "failures: $fails"; [[ "$fails" -eq 0 ]]
