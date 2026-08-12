#!/usr/bin/env bash
# send-prompt.sh の回帰テスト。
#
# 守っている不変条件:
#   SP0. 未知フラグ・必須フラグ欠落は exit 2 の使用法エラーになり、配送は起きない
#   SP1. agmsg ready sentinel がある宛先では cmux を 1 度も呼ばない
#   SP2. sentinel が無ければタイプ入力経路に落ちる
#   SP3. 閾値超えは outbox にファイル化され、1 行のポインタだけがタイプされる
#   SP4. 同一 label の 2 通目は連番になり 1 通目を上書きしない
#   SP5. 閾値以下は素のテキストとしてタイプされる
#   SP6. outbox への書き込み失敗 (mkdir -p / printf) は exit 1 になり配送しない
#   SP7. '/' を含む --label は exit 2 の使用法エラーになり配送しない

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

# --- SP3: 閾値超えは outbox にファイル化され、1 行のポインタだけがタイプされる ---
reset_logs
LONG="$(printf 'x%.0s' $(seq 1 500))"
run_sp --to-surface surface:2 --label codereview --outbox-dir "$TMP/outbox" -- "$LONG"
outfile="$TMP/outbox/codereview-1.md"
if [[ -f "$outfile" ]] \
   && [[ "$(cat "$outfile")" == "$LONG" ]] \
   && grep -qF "cmux send --surface surface:2 codereview: read $outfile and follow every instruction in it." "$TMP/cmux.log" \
   && ! grep -qF "xxxxxxxxxx" "$TMP/cmux.log"; then
  echo "PASS SP3: 閾値超えはファイル化され 1 行のポインタだけがタイプされる"
else
  echo "FAIL SP3: outfile=[$outfile] cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
fi

# --- SP4: 同一 label の 2 通目は連番になり 1 通目を上書きしない ---
reset_logs
LONG2="$(printf 'y%.0s' $(seq 1 500))"
run_sp --to-surface surface:2 --label codereview --outbox-dir "$TMP/outbox" -- "$LONG2"
if [[ "$(cat "$TMP/outbox/codereview-1.md")" == "$LONG" ]] \
   && [[ "$(cat "$TMP/outbox/codereview-2.md")" == "$LONG2" ]]; then
  echo "PASS SP4: 同一 label の 2 通目は連番になり 1 通目を上書きしない"
else
  echo "FAIL SP4: outbox=[$(ls "$TMP/outbox")]"; fail=1
fi

# --- SP5: 閾値以下は素のテキストとしてタイプされる ---
reset_logs
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
if grep -qF 'cmux send --surface surface:2 short message' "$TMP/cmux.log" \
   && [[ ! -f "$TMP/outbox/notify-1.md" ]]; then
  echo "PASS SP5: 閾値以下はファイル化せず素のテキストでタイプされる"
else
  echo "FAIL SP5: cmux.log=[$(cat "$TMP/cmux.log")] outbox=[$(ls "$TMP/outbox")]"; fail=1
fi

# --- SP6: outbox への書き込み失敗は exit 1 (使用法エラーの 2 ではない) になり配送しない ---
reset_logs
if [[ $EUID -ne 0 ]]; then
  mkdir -p "$TMP/ro-parent"
  chmod 000 "$TMP/ro-parent"
  LONG3="$(printf 'z%.0s' $(seq 1 500))"
  run_sp --to-surface surface:2 --label codereview --outbox-dir "$TMP/ro-parent/outbox" -- "$LONG3" >/dev/null 2>&1
  rc=$?
  chmod 755 "$TMP/ro-parent"
  if [[ $rc -eq 1 ]] && [[ ! -s "$TMP/cmux.log" ]]; then
    echo "PASS SP6: outbox への書き込み失敗は exit 1 になり配送しない"
  else
    echo "FAIL SP6: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
  fi
else
  echo "PASS SP6: outbox への書き込み失敗は exit 1 になり配送しない (skipped as root)"
fi

# --- SP7: '/' を含む --label は exit 2 の使用法エラーになり配送しない ---
reset_logs
run_sp --to-surface surface:2 --label "foo/bar" -- "hello" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 2 ]] && [[ ! -s "$TMP/cmux.log" ]] && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP7: '/' を含む --label は exit 2 の使用法エラーになり配送しない"
else
  echo "FAIL SP7: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

exit $fail
