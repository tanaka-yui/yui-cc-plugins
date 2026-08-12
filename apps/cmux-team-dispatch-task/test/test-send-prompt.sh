#!/usr/bin/env bash
# send-prompt.sh の回帰テスト。
#
# 守っている不変条件:
#   SP0. 未知フラグ・必須フラグ欠落は exit 2 の使用法エラーになり、配送は起きない
#   SP1. agmsg ready sentinel がある宛先では cmux を 1 度も呼ばない
#   SP2. sentinel が無ければタイプ入力経路に落ちる

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/send-prompt.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# cmux / send.sh のスタブ。呼び出し引数を log に追記する。
# read-screen だけは「入力欄が空」を表す画面を返し、Enter 検証を通す。
make_stubs() {
  mkdir -p "$TMP/bin" "$TMP/run" "$TMP/outbox"
  cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "cmux $*" >> "$CMUX_LOG"
if [[ "$1" == "read-screen" ]]; then
  printf '%s\n' "some output" "❯ " "  status line"
fi
exit 0
STUB
  cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "send.sh $*" >> "$AGMSG_LOG"
exit 0
STUB
  chmod +x "$TMP/bin/cmux" "$TMP/bin/send.sh"
}

run_sp() {
  CMUX_LOG="$TMP/cmux.log" AGMSG_LOG="$TMP/agmsg.log" \
  CMUX_BIN="$TMP/bin/cmux" AGMSG_SEND="$TMP/bin/send.sh" AGMSG_READY_DIR="$TMP/run" \
  bash "$BIN" "$@"
}

reset_logs() { : > "$TMP/cmux.log"; : > "$TMP/agmsg.log"; }

make_stubs

# --- SP0: 使用法エラー ---

# SP0a: 未知フラグ(タイプミス)は message text に飲み込まれず exit 2
reset_logs
run_sp --to-surface surface:2 --label x --unknown-flag "the actual message" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 2 ]] && [[ ! -s "$TMP/cmux.log" ]] && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP0a: 未知フラグは exit 2 の使用法エラーになり配送しない"
else
  echo "FAIL SP0a: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# SP0b: --label 欠落は exit 2
reset_logs
run_sp --to-surface surface:2 -- "hello" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 2 ]] && [[ ! -s "$TMP/cmux.log" ]] && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP0b: --label 欠落は exit 2 の使用法エラーになり配送しない"
else
  echo "FAIL SP0b: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# SP0c: 宛先(--to-workspace / --to-surface どちらも)欠落は exit 2
reset_logs
run_sp --label x -- "hello" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 2 ]] && [[ ! -s "$TMP/cmux.log" ]] && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP0c: 宛先欠落は exit 2 の使用法エラーになり配送しない"
else
  echo "FAIL SP0c: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# SP0d: -- 以降はフラグとして解釈されず message text として扱われる(terminator の挙動を壊していない確認)
reset_logs
run_sp --to-surface surface:2 --label x -- --to-surface x >/dev/null 2>&1
rc=$?
if [[ $rc -eq 0 ]] && grep -q 'cmux send --surface surface:2 --to-surface x' "$TMP/cmux.log"; then
  echo "PASS SP0d: -- 以降はメッセージ本文として扱われフラグとして解釈されない"
else
  echo "FAIL SP0d: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
fi

# --- SP1: ready sentinel あり → agmsg のみ、cmux は呼ばれない ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if [[ ! -s "$TMP/cmux.log" ]] && grep -q 'send.sh myteam impl reviewer hello reviewer' "$TMP/agmsg.log"; then
  echo "PASS SP1: ready sentinel がある宛先では cmux を呼ばず agmsg のみで送る"
else
  echo "FAIL SP1: cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# --- SP2: sentinel なし → タイプ入力経路 ---
reset_logs
rm -f "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if grep -q 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log" \
   && grep -q 'cmux send-key --surface surface:2 return' "$TMP/cmux.log" \
   && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP2: sentinel が無ければタイプ入力経路に落ちる"
else
  echo "FAIL SP2: cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

exit $fail
