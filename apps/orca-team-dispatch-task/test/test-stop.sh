#!/usr/bin/env bash
# ユーザーが選んだ役を止める。**記録してから閉じる**ことと、**止め切れなかったら
# 止め切れなかったと言う**ことが全部である。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
S="$P/bin/orca-stop.sh"
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
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN ORCA_STUB_DIR ORCA_TERMINAL_HANDLE; }
st() { bash "$S" --status-dir "$SD" "$@"; }
argv() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log"; }

# SP1: 使用法。--role と --snooze はどちらか 1 つだけ
setup; st >/dev/null 2>&1; a=$?; st --role design --snooze >/dev/null 2>&1; b=$?
bash "$S" --role design >/dev/null 2>&1; c=$?
[[ "$a" -eq 2 && "$b" -eq 2 && "$c" -eq 2 ]] && ok "SP1 使用法エラー" || fail "SP1 ($a/$b/$c)"; teardown

# SP2: ★ **reviewer を止める。**記録 → 端末を閉じる → 依頼側へ review-skipped。時計も数え直す
setup; st --role design_review >/dev/null 2>&1; rc=$?
cl=$(grep 'terminal close' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && -f "$SD/roles/design_review/stopped.json" \
   && "$(jq -r '.by' "$SD/roles/design_review/stopped.json")" == user \
   && "$cl" == *'--terminal term_r'* ]] \
  && argv | grep -qx 'review-skipped: stopped by the user' \
  && argv | grep -qx 'dispatch:ctx_x' \
  && [[ "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && ok "SP2 reviewer を止めて依頼側を進ませる" || fail "SP2 (rc=$rc cl=$cl)"; teardown

# SP3: ★ **記録できなければ閉じない。**記録の無い停止は、待機からは worker の消失に見える
setup; : > "$SD/roles/design_review"   # 役 dir の位置に通常ファイルを置き、記録を失敗させる
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP3 記録できなければ閉じない" || fail "SP3 (rc=$rc)"; teardown

# SP4: 決着済みの役には何もしない
setup; echo '["worker_done|task_r|ctx_r|succeeded"]' > "$SD/received.json"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && ! -e "$SD/roles/design_review/stopped.json" ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP4 決着済みには触らない" || fail "SP4 (rc=$rc)"; teardown

# SP5: 閉じられなければ 1。ただし記録は残す（待機は止めた役として扱える）
setup; echo 1 > "$ORCA_STUB_DIR/terminal_close.rc"
st --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && -f "$SD/roles/design_review/stopped.json" ]] \
  && ok "SP5 閉じられなくても記録は残す" || fail "SP5 (rc=$rc)"; teardown

# SP6: --snooze は snoozed_at を今にし、detected_at を消す
setup; echo '{"detected_at":5,"idle_min":130}' > "$SD/stall.json"
st --snooze >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && "$(jq -r '.snoozed_at' "$SD/stall.json")" =~ ^[0-9]+$ ]] \
  && jq -e 'has("detected_at") | not' "$SD/stall.json" >/dev/null \
  && ok "SP6 snooze" || fail "SP6 (rc=$rc)"; teardown

# SP7: 作る役を止めても review-skipped は送らない（送る相手が居ない）
setup; st --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && -f "$SD/roles/design/stopped.json" ]] \
  && ! grep -q 'orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "SP7 作る役を止めても review-skipped を送らない" || fail "SP7 (rc=$rc)"; teardown

# SP8: dispatch の記録が無い役は止められない（何を止めるか分からない）
setup; st --role exec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && ! -e "$SD/roles/exec/stopped.json" ]] \
  && ok "SP8 記録の無い役は止めない" || fail "SP8 (rc=$rc)"; teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
