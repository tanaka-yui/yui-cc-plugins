#!/usr/bin/env bash
# ユーザーが選んだ役を止める。**記録してから止める**ことと、**止め切れなかったら
# 止め切れなかったと言う**ことと、**端末を直接閉じない**ことが全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
S="$P/bin/orca-stop.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  export ORCA_TERMINAL_HANDLE=term_p
  : > "$ORCA_STUB_DIR/calls.log"; : > "$ORCA_STUB_DIR/argv.log"
  SD=$(mktemp -d); mkdir -p "$SD/roles/design"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}\n' > "$SD/run.json"
  jq -nc '{integration_role:"design",roles:{
    design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x"},
    design_review:{terminal:"term_r",task:"task_r",dispatch:"ctx_r"}}}' > "$SD/workers.json"
  echo '{"ok":true,"result":{"message":{"id":"m1"}}}' > "$ORCA_STUB_DIR/orchestration_send"
  echo '{"ok":true,"result":{"worker":{"state":"active"},"dispatch":{"status":"dispatched"}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-show"
  # 止めたあとの読み直し。既定は「Orca が端末を閉じた」
  released ctx_r; released ctx_x
}
# $1=dispatch $2=releaseState $3=retainedReason。worker-list の行を足す（同じ dispatch は置き換える）
row() {
  local f="$ORCA_STUB_DIR/orchestration_worker-list" cur
  cur=$(jq -c '.result.workers // []' "$f" 2>/dev/null) || cur='[]'
  jq -nc --argjson w "$cur" --arg d "$1" --arg s "$2" --arg r "${3:-}" \
    '{ok:true,result:{workers:([$w[] | select(.dispatchId != $d)] + [{dispatchId:$d,terminalState:$s,
      resource:{releaseState:$s,retainedReason:(if $r == "" then null else $r end)}}])}}' > "$f"
}
released() { row "$1" released; }
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN ORCA_STUB_DIR ORCA_TERMINAL_HANDLE; }
st() { node "$S" --status-dir "$SD" "$@"; }
argv() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log"; }
# 止める操作（Orca への worker-stop / worker-release、そして使ってはならない terminal close）
stops() { grep -E 'worker-stop|worker-release|terminal close' "$ORCA_STUB_DIR/calls.log"; }

# SP1: 使用法。--role と --snooze はどちらか 1 つだけ
setup; st >/dev/null 2>&1; a=$?; st --role design --snooze >/dev/null 2>&1; b=$?
node "$S" --role design >/dev/null 2>&1; c=$?
[[ "$a" -eq 2 && "$b" -eq 2 && "$c" -eq 2 ]] && ok "SP1 使用法エラー" || fail "SP1 ($a/$b/$c)"; teardown

# SP2: ★ **reviewer を止める。**記録 → Orca に止めさせる（worker-stop）→ 依頼側へ review-skipped。
#      時計も数え直す。**端末を直接閉じない**
setup; st --role design_review >/dev/null 2>&1; rc=$?
ws=$(grep 'orchestration worker-stop' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && -f "$SD/roles/design_review/stopped.json" \
   && "$(jq -r '.by' "$SD/roles/design_review/stopped.json")" == user \
   && "$ws" == *'--dispatch ctx_r'* ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && argv | grep -qx 'review-skipped: stopped by the user' \
  && argv | grep -qx 'dispatch:ctx_x' \
  && [[ "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && ok "SP2 reviewer を止めて依頼側を進ませる" || fail "SP2 (rc=$rc ws=$ws)"; teardown

# SP3: ★ **記録できなければ止めない。**記録の無い停止は、待機からは worker の消失に見える
setup; : > "$SD/roles/design_review"   # 役 dir の位置に通常ファイルを置き、記録を失敗させる
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && -z "$(stops)" ]] \
  && ok "SP3 記録できなければ止めない" || fail "SP3 (rc=$rc)"; teardown

# SP4: 決着済みの役には何もしない
setup; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && ! -e "$SD/roles/design_review/stopped.json" && -z "$(stops)" ]] \
  && ok "SP4 決着済みには触らない" || fail "SP4 (rc=$rc)"; teardown

# SP5: 止められなければ 1。ただし記録は残す（待機は止めた役として扱える）
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_worker-stop.rc"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && -f "$SD/roles/design_review/stopped.json" ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP5 止められなくても記録は残す" || fail "SP5 (rc=$rc)"; teardown

# SP6: --snooze は snoozed_at を今にし、detected_at を消す
setup; echo '{"detected_at":5,"idle_min":130}' > "$SD/stall.json"
st --snooze >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && jq -e 'has("detected_at") | not' "$SD/stall.json" >/dev/null \
  && ok "SP6 snooze" || fail "SP6 (rc=$rc)"; teardown

# SP7: ★ **作る役を止めたら、その reviewer に abort-reviewer を送る。**送らないと reviewer は
#      来ない依頼を待ち続け、同じタスクがまた停滞として尋ねられる。review-skipped は送らない
setup; st --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && -f "$SD/roles/design/stopped.json" ]] \
  && argv | grep -qx 'abort-reviewer: stopped by the user' \
  && argv | grep -qx 'dispatch:ctx_r' \
  && ! argv | grep -q '^review-skipped:' \
  && ok "SP7 作る役を止めたら reviewer を終わらせる" || fail "SP7 (rc=$rc)"; teardown

# SP8: dispatch の記録が無い役は止められない（何を止めるか分からない）
setup; st --role exec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -e "$SD/roles/exec/stopped.json" ]] \
  && ok "SP8 記録の無い役は止めない" || fail "SP8 (rc=$rc)"; teardown

# SP9: ★ **決着済みの reviewer を止めても、依頼側はまだ verdict を待っている。**verdict を
#      届けられずに終えた reviewer は worker_done を送って決着する。依頼側が決着していなければ
#      review-skipped を送る。記録も止めることもしない（止める対象がもう無い）
setup; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && ! -e "$SD/roles/design_review/stopped.json" && -z "$(stops)" ]] \
  && argv | grep -qx 'review-skipped: stopped by the user' && argv | grep -qx 'dispatch:ctx_x' \
  && ok "SP9 決着済みの reviewer でも依頼側を進ませる" || fail "SP9 (rc=$rc)"; teardown

# SP10: 依頼側も決着済みなら何も送らない（待っている者が居ない）
setup; echo '["worker_done|task_r|ctx_r|succeeded","worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ! grep -q 'orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP10 依頼側も決着済みなら送らない" || fail "SP10 (rc=$rc)"; teardown

# SP11: 決着済みの reviewer には abort-reviewer を送らない（読む者が居ない）
setup; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
st --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && -f "$SD/roles/design/stopped.json" ]] \
  && ! grep -q 'orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP11 決着済みの reviewer には送らない" || fail "SP11 (rc=$rc)"; teardown

# SP12: ★ **止めた役をもう一度止めても失敗にしない。**記録は上書きせず、止め直しもしない。
#       依頼側への知らせは今回も送る（前回届かなかったかもしれない）
setup; mkdir -p "$SD/roles/design_review"; echo '{"stopped_at":1,"by":"user"}' > "$SD/roles/design_review/stopped.json"
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-stop.rc"
err=$(st --role design_review 2>&1 >/dev/null); rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.stopped_at' "$SD/roles/design_review/stopped.json")" == 1 \
   && "$err" == *"already stopped"* && -z "$(stops)" ]] \
  && argv | grep -qx 'review-skipped: stopped by the user' \
  && ok "SP12 止めた役を止め直しても 0" || fail "SP12 (rc=$rc err=$err)"; teardown

# SP13: exec を止めたら exec_review へ abort-reviewer（design の組と同じ）
setup
jq -nc '{integration_role:"exec",roles:{
  design:{terminal:"term_w",task:"task_x",dispatch:"ctx_x"},
  exec:{terminal:"term_e",task:"task_e",dispatch:"ctx_e"},
  exec_review:{terminal:"term_q",task:"task_q",dispatch:"ctx_q"}}}' > "$SD/workers.json"
echo '["worker_done|task_x|ctx_x|succeeded"]' > "$SD/received.json"
released ctx_e
st --role exec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && -f "$SD/roles/exec/stopped.json" ]] \
  && argv | grep -qx 'abort-reviewer: stopped by the user' && argv | grep -qx 'dispatch:ctx_q' \
  && ok "SP13 exec を止めたら exec_review を終わらせる" || fail "SP13 (rc=$rc)"; teardown

# SP14: ★ **Orca が決着済みと言う worker は release で閉じる。**worker_done は届いたが、親がまだ
#       drain していない。release は出力を保存してから閉じる。stop は打たない
setup
echo '{"ok":true,"result":{"worker":{"state":"succeeded"},"dispatch":{"status":"completed"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
st --role design_review >/dev/null 2>&1; rc=$?
wr=$(grep 'orchestration worker-release' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && "$wr" == *'--dispatch ctx_r'* ]] \
  && ! grep -qE 'worker-stop|terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP14 決着済みの worker は release で閉じる" || fail "SP14 (rc=$rc wr=$wr)"; teardown

# SP15: ★ **receipt が ok でも、Orca が端末を保持したままなら「閉じた」と言わない**（実測 O43）。
#       記録は残し、1 で返して理由を言う
setup; row ctx_r retained user_takeover
err=$(st --role design_review 2>&1 >/dev/null); rc=$?
[[ "$rc" -eq 1 && -f "$SD/roles/design_review/stopped.json" \
   && "$err" == *'releaseState: retained, retainedReason: user_takeover'* ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP15 保持されたままなら閉じたと言わない" || fail "SP15 (rc=$rc err=$err)"; teardown

# SP16: ★ **worker の状態が読めなければ、止めも閉じもしない。**記録は残す（生死の分からないものには触らない）
setup; echo '{"ok":false,"error":{"code":"unavailable"}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && -f "$SD/roles/design_review/stopped.json" && -z "$(stops)" ]] \
  && ok "SP16 状態が読めなければ止めない" || fail "SP16 (rc=$rc)"; teardown

# SP16b: ★ **ok でも、決着か稼働かの証拠が読めなければ何も打たない。**state が無い・outcome_unknown などは
#        「読めない」と同じ（証拠の無いまま stop すると、決着済みの worker の出力を保存せずに閉じうる）
setup; echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
st --role design_review >/dev/null 2>&1; a=$?; a_stops=$(stops); teardown
setup; echo '{"ok":true,"result":{"worker":{"state":"outcome_unknown"},"dispatch":{"status":"dispatched"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
err=$(st --role design_review 2>&1 >/dev/null); b=$?
[[ "$a" -eq 1 && -z "$a_stops" && "$b" -eq 1 && -z "$(stops)" && -f "$SD/roles/design_review/stopped.json" \
   && "$err" == *"state 'outcome_unknown'"* ]] \
  && ok "SP16b 証拠が読めなければ止めない" || fail "SP16b ($a/$b err=$err)"; teardown

# SP17: 読み直しができなければ「閉じた」と言わない（一覧が読めない / その worker が載っていない）
setup; echo 7 > "$ORCA_STUB_DIR/orchestration_worker-list.rc"
st --role design_review >/dev/null 2>&1; a=$?; teardown
setup; row ctx_x released; jq -c '.result.workers |= map(select(.dispatchId != "ctx_r"))' \
  "$ORCA_STUB_DIR/orchestration_worker-list" > "$ORCA_STUB_DIR/l" && mv "$ORCA_STUB_DIR/l" "$ORCA_STUB_DIR/orchestration_worker-list"
st --role design_review >/dev/null 2>&1; b=$?
[[ "$a" -eq 1 && "$b" -eq 1 ]] && ok "SP17 読み直せなければ閉じたと言わない" || fail "SP17 ($a/$b)"; teardown

# SP18: zsh から呼んでも同じ結果になる（設計 3-5。呼び出し側のシェルに依存しない）
if command -v zsh >/dev/null 2>&1; then
  setup; echo '{"detected_at":5}' > "$SD/stall.json"
  zsh -c 'node "$1" --status-dir "$2" --snooze' zsh "$S" "$SD" >/dev/null 2>&1; rc=$?
  [[ "$rc" -eq 0 ]] && jq -e 'has("snoozed_at") and (has("detected_at") | not)' "$SD/stall.json" >/dev/null \
    && ok "SP18 zsh から呼んでも同じ結果" || fail "SP18 (rc=$rc)"; teardown
else
  echo "SKIP: SP18 zsh が無い"
fi

# SP19: ★ **Orca が start_unknown と言う worker も止める。**生死のどちらの証拠でもないが、worker-stop は dispatch を
#       fence するので、生きていても死んでいても「止める」として正しい。以前は何も打たず、止めると決めた役が
#       止まらなかった（2026-09-24）。Orca は start_unknown の worker への worker-stop を受け付ける（手で確認）
setup; echo '{"ok":true,"result":{"worker":{"state":"start_unknown"},"dispatch":{"status":"pending"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
st --role design_review >/dev/null 2>&1; rc=$?
ws=$(grep 'orchestration worker-stop' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && "$ws" == *'--dispatch ctx_r'* && -f "$SD/roles/design_review/stopped.json" ]] \
  && ! grep -qE 'worker-release|terminal close' "$ORCA_STUB_DIR/calls.log" \
  && argv | grep -qx 'review-skipped: stopped by the user' \
  && ok "SP19 start_unknown の worker も止める" || fail "SP19 (rc=$rc ws=$ws)"; teardown

# SP20: ★ **reviewer を止めても、端末で答えを待つ design の入力欄には打たない。**review-skipped は届け、
#       design は答えを受けたあとの verdict 待ちでそれを読む（最終レビューの指摘）
setup; echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
echo '{"asked_at":1}' > "$SD/roles/design/awaiting-user.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && argv | grep -qx 'review-skipped: stopped by the user' \
  && ! argv | grep -qx 'term_w' \
  && ok "SP20 答えを待つ design には打たない" || fail "SP20 (rc=$rc)"; teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
