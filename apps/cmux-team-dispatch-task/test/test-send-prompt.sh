#!/usr/bin/env bash
# send-prompt.sh の回帰テスト。
#
# 守っている不変条件:
#   SP0. 未知フラグ・必須フラグ欠落は exit 2 の使用法エラーになり、配送は起きない
#   SP1. agmsg ready sentinel がある宛先では agmsg に記録し、かつタイプ入力も行う (dual-send)
#   SP2. sentinel が無ければ agmsg 記録はスキップされ、タイプ入力だけが行われる
#   SP3. 閾値超えは outbox にファイル化され、1 行のポインタだけがタイプされる
#   SP4. 同一 label の 2 通目は連番になり 1 通目を上書きしない
#   SP5. 閾値以下は素のテキストとしてタイプされる
#   SP6. outbox への書き込み失敗 (mkdir -p / printf) は exit 1 になり配送しない
#   SP7. '/' を含む --label は exit 2 の使用法エラーになり配送しない
#   SP8. 入力欄が空なら Enter は 1 回だけで成功する
#   SP9. 入力欄に残る場合は Enter を再送し、尽きたら exit 1 になる
#   SP10. read-screen が観測できない (空出力) 場合は観測失敗として成功扱いにする
#   SP11. 画面は非空だが入力欄行 (❯/>) が見つからない場合も観測失敗として成功扱いにする
#   SP12. agmsg の send.sh が失敗してもタイプ入力は行われ、終了コードは 0 のまま
#   SP13. 閾値超えの本文を sentinel のある宛先へ送ると、agmsg には全文が渡りタイプ入力側はポインタ 1 行になる
#   SP14. 画面に送信済みプロンプトの反響 (probe と一致する ❯ 行) があっても、最後の ❯ 行 (入力欄) が
#         空なら反響行は無視され、Enter は 1 回だけで成功する
#   SP15. 改行を含む閾値以下の本文でも、入力欄が空なら Enter は 1 回だけで成功する
#   SP16. 改行を含む本文が実際に入力欄へ残っている場合は従来どおり再送し exit 1 する
#   SP17. 先頭が改行で照合対象が取れない本文は観測不能扱い (fail-open) にする
#   SP18. agmsg の inbox 記録はタイプ入力と Enter の後に行う (send.sh が固まっても
#         唯一の wake 手段であるタイプ入力を止めない)
#   SP19. --retries 0 でも入力欄を 1 回検証し、空なら成功する
#   SP20. --retries 0 で入力欄に残る場合は再送せず exit 1 する
#   SP21. --retries 0 の read-screen 空出力は観測失敗として成功扱いにする
#   SP22. --retries 0 のプロンプト行未検出は観測失敗として成功扱いにする
#   SP23. --retries 1 は検証 2 回・Enter 2 回で詰まり続けたら exit 1 する
#   SP24. --retries 1 は 2 回目の検証で解消したら余分な検証なしに成功する

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/send-prompt.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# cmux / send.sh のスタブ。呼び出し引数を log に追記する。
# 両者は個別の log に加えて共有の ORDER_LOG にも追記するので、呼び出し順序を検査できる。
# read-screen は SCREEN_FIXTURE が指すファイルの内容を返す (未設定 or ファイルが無ければ空出力)。
make_stubs() {
  mkdir -p "$TMP/bin" "$TMP/run" "$TMP/outbox"
  cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "cmux $*" >> "$CMUX_LOG"
printf '%s\n' "cmux $*" >> "$ORDER_LOG"
if [[ "$1" == "read-screen" ]]; then
  [[ -n "${SCREEN_FIXTURE:-}" && -f "$SCREEN_FIXTURE" ]] && cat "$SCREEN_FIXTURE"
fi
exit 0
STUB
  cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "send.sh $*" >> "$AGMSG_LOG"
printf '%s\n' "send.sh $*" >> "$ORDER_LOG"
exit 0
STUB
  chmod +x "$TMP/bin/cmux" "$TMP/bin/send.sh"
}

run_sp() {
  CMUX_LOG="$TMP/cmux.log" AGMSG_LOG="$TMP/agmsg.log" ORDER_LOG="$TMP/order.log" \
  SCREEN_FIXTURE="${SCREEN_FIXTURE:-}" \
  TMP="$TMP" SCREEN_COUNT="${SCREEN_COUNT:-}" \
  CMUX_BIN="$TMP/bin/cmux" AGMSG_SEND="$TMP/bin/send.sh" AGMSG_READY_DIR="$TMP/run" \
  bash "$BIN" "$@"
}

reset_logs() { : > "$TMP/cmux.log"; : > "$TMP/agmsg.log"; : > "$TMP/order.log"; }

make_stubs

# SP1-SP7 は「入力欄は空」を前提にした検証なので、既定 fixture を空画面にしておく。
printf '%s\n' "some output" "❯ " "  status line" > "$TMP/screen-empty.txt"
printf '%s\n' "some output" "❯ short message" "  status line" > "$TMP/screen-stuck.txt"
printf '%s\n' "some output" "more output" "  status line" > "$TMP/screen-no-prompt.txt"

# SP14 用: 実際の Claude Code TUI 画面を模した fixture。1 行目が送信済みプロンプトの
# 反響 (probe と 30 文字以上一致)、中間が反響の折り返し行とアシスタント出力、
# 最後の行が空の入力欄 (実際の ❯)。
SP14_MSG="review-code: read the outbox file and follow every instruction in it now"
printf '%s\n' \
  "❯ ${SP14_MSG:0:30}" \
  "  ${SP14_MSG:30}" \
  "⏺ I'll read the instruction file first." \
  "─────────────────────────" \
  "❯ " \
  > "$TMP/screen-echo-then-empty.txt"
SCREEN_FIXTURE="$TMP/screen-empty.txt"

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

# --- SP1: ready sentinel あり → agmsg に記録し、かつタイプ入力も行う (dual-send) ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if grep -q 'send.sh myteam impl reviewer hello reviewer' "$TMP/agmsg.log" \
   && grep -qF 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log" \
   && grep -q 'cmux send-key --surface surface:2 return' "$TMP/cmux.log"; then
  echo "PASS SP1: ready sentinel がある宛先では agmsg に記録し、かつタイプ入力も行う"
else
  echo "FAIL SP1: cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi

# --- SP2: sentinel なし → agmsg 記録はスキップされタイプ入力だけが行われる ---
reset_logs
rm -f "$TMP/run/ready.myteam__reviewer"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer"
if grep -q 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log" \
   && grep -q 'cmux send-key --surface surface:2 return' "$TMP/cmux.log" \
   && [[ ! -s "$TMP/agmsg.log" ]]; then
  echo "PASS SP2: sentinel が無ければ agmsg 記録はスキップされタイプ入力だけが行われる"
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

# --- SP8: 入力欄が空なら Enter は 1 回だけで成功する ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP8: 入力欄が空なら Enter は 1 回だけで成功する"
else
  echo "FAIL SP8: rc=$rc send-key回数=$n"; fail=1
fi

# --- SP9: 入力欄に残る場合は Enter を再送し、尽きたら exit 1 ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-stuck.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- "short message" >/dev/null 2>&1
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 1 && $n -eq 4 ]]; then
  echo "PASS SP9: 入力欄に残る場合は Enter を 3 回再送して exit 1 する"
else
  echo "FAIL SP9: rc=$rc send-key回数=$n (期待 rc=1, 回数=4)"; fail=1
fi

# --- SP10: read-screen が空出力なら観測失敗として成功扱いにする ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-missing.txt"   # 存在しない = 空出力
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP10: read-screen が空出力なら観測失敗として成功扱いにする"
else
  echo "FAIL SP10: rc=$rc send-key回数=$n"; fail=1
fi

# --- SP11: 画面は非空だが入力欄行が見つからない場合も観測失敗として成功扱いにする ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-no-prompt.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" -- "short message"
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP11: 入力欄行が見つからない画面は観測失敗として成功扱いにする"
else
  echo "FAIL SP11: rc=$rc send-key回数=$n"; fail=1
fi
SCREEN_FIXTURE="$TMP/screen-empty.txt"

# --- SP12: agmsg の send.sh が失敗してもタイプ入力は行われ、終了コードは 0 のまま ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
cat > "$TMP/bin/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "send.sh $*" >> "$AGMSG_LOG"
exit 1
STUB
chmod +x "$TMP/bin/send.sh"
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "hello reviewer" 2>/dev/null
rc=$?
if [[ $rc -eq 0 ]] \
   && grep -q 'send.sh myteam impl reviewer' "$TMP/agmsg.log" \
   && grep -qF 'cmux send --surface surface:2 hello reviewer' "$TMP/cmux.log"; then
  echo "PASS SP12: agmsg の記録が失敗してもタイプ入力は行われ、終了コードは 0 のまま"
else
  echo "FAIL SP12: rc=$rc cmux.log=[$(cat "$TMP/cmux.log")]"; fail=1
fi
rm -f "$TMP/run/ready.myteam__reviewer"
# send.sh スタブを既定(成功)に戻す。以降のテスト追加時に本テストの失敗スタブが
# 残らないようにする。
make_stubs

# --- SP13: 閾値超えの本文を sentinel のある宛先へ送ると、agmsg には全文が渡り
#           タイプ入力側はポインタ 1 行になる ---
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
LONG4="$(printf 'w%.0s' $(seq 1 500))"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "$LONG4"
outfile="$TMP/outbox/codereview-3.md"
if grep -qF "send.sh myteam impl reviewer $LONG4" "$TMP/agmsg.log" \
   && [[ -f "$outfile" ]] \
   && [[ "$(cat "$outfile")" == "$LONG4" ]] \
   && grep -qF "cmux send --surface surface:2 codereview: read $outfile and follow every instruction in it." "$TMP/cmux.log" \
   && ! grep -qF "wwwwwwwwww" "$TMP/cmux.log"; then
  echo "PASS SP13: 閾値超えの本文は agmsg に全文、タイプ入力側はポインタ1行になる"
else
  echo "FAIL SP13: outfile=[$outfile] cmux.log=[$(cat "$TMP/cmux.log")] agmsg.log=[$(cat "$TMP/agmsg.log")]"; fail=1
fi
rm -f "$TMP/run/ready.myteam__reviewer"

# --- SP14: 画面上に送信済みプロンプトの反響 (probe と一致する ❯ 行) があっても、
#           最後の ❯ 行 (実際の入力欄) が空なら反響行は無視され、Enter は 1 回だけで成功する ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-echo-then-empty.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- "$SP14_MSG" >/dev/null 2>&1
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP14: 送信済みプロンプトの反響ではなく最後の ❯ 行だけを入力欄として検証する"
else
  echo "FAIL SP14: rc=$rc send-key回数=$n"; fail=1
fi
SCREEN_FIXTURE="$TMP/screen-empty.txt"

# --- SP15: 改行を含む閾値以下の本文でも、入力欄が空なら Enter は 1 回だけで成功する ---
# grep -F はパターン中の改行を「パターンの区切り」として扱うため、改行を含む文字列を
# そのまま probe に渡すと空パターンが生まれて全行にマッチし、配送に成功していても
# 必ず「入力欄が埋まっている」と誤検出する。probe は本文の 1 行目から取る。
reset_logs
SCREEN_FIXTURE="$TMP/screen-empty.txt"
MULTILINE_MSG=$'Phase A task: implement X.\n\nDetails: do the thing carefully.'
run_sp --to-surface surface:2 --label phase-a-task --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- "$MULTILINE_MSG" >/dev/null 2>&1
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP15: 改行を含む本文でも入力欄が空なら Enter は 1 回だけで成功する"
else
  echo "FAIL SP15: rc=$rc send-key回数=$n (期待 rc=0, 回数=1)"; fail=1
fi

# --- SP16: 改行を含む本文が実際に入力欄へ残っている場合は従来どおり検出する ---
# SP15 の修正が「改行入りは常に成功扱い」へ行き過ぎていないことを守る。
reset_logs
printf '%s\n' "some output" "❯ Phase A task: implement X." "  status line" > "$TMP/screen-stuck-multiline.txt"
SCREEN_FIXTURE="$TMP/screen-stuck-multiline.txt"
run_sp --to-surface surface:2 --label phase-a-task --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- "$MULTILINE_MSG" >/dev/null 2>&1
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 1 && $n -eq 4 ]]; then
  echo "PASS SP16: 改行を含む本文が入力欄に残る場合は再送して exit 1 する"
else
  echo "FAIL SP16: rc=$rc send-key回数=$n (期待 rc=1, 回数=4)"; fail=1
fi

# --- SP17: 先頭が改行の本文は照合対象が無いので観測不能扱い (fail-open) にする ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-stuck.txt"   # 入力欄に何か残っている画面でも失敗にしない
run_sp --to-surface surface:2 --label phase-a-task --outbox-dir "$TMP/outbox" \
       --retries 3 --settle 0 -- $'\nleading newline body' >/dev/null 2>&1
rc=$?
n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
if [[ $rc -eq 0 && $n -eq 1 ]]; then
  echo "PASS SP17: 先頭が改行の本文は観測不能扱いで配送済みとする"
else
  echo "FAIL SP17: rc=$rc send-key回数=$n (期待 rc=0, 回数=1)"; fail=1
fi
SCREEN_FIXTURE="$TMP/screen-empty.txt"

# --- SP18: agmsg の inbox 記録はタイプ入力より後に行う ---
# send.sh は共有 SQLite DB へ書き込むので固まりうる。macOS には timeout/gtimeout が
# 無く強制打ち切りもできないため、唯一の wake 手段であるタイプ入力より前に走らせては
# ならない (記録は単なるログで、これに依存する処理は無い)。
reset_logs
touch "$TMP/run/ready.myteam__reviewer"
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --agmsg-team myteam --agmsg-to reviewer \
       --agmsg-from impl --label codereview --outbox-dir "$TMP/outbox" -- "ordered message"
send_ln=$(grep -n 'cmux send --surface' "$TMP/order.log" | head -1 | cut -d: -f1)
key_ln=$(grep -n 'cmux send-key' "$TMP/order.log" | head -1 | cut -d: -f1)
agmsg_ln=$(grep -n 'send.sh myteam' "$TMP/order.log" | head -1 | cut -d: -f1)
if [[ -n "$send_ln" && -n "$key_ln" && -n "$agmsg_ln" ]] \
   && [[ $agmsg_ln -gt $send_ln && $agmsg_ln -gt $key_ln ]]; then
  echo "PASS SP18: agmsg の inbox 記録はタイプ入力と Enter の後に行われる"
else
  echo "FAIL SP18: order.log=[$(tr '\n' '|' < "$TMP/order.log")]"; fail=1
fi
rm -f "$TMP/run/ready.myteam__reviewer"

# --- SP19: --retries 0 でも入力欄を 1 回検証する ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-empty.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 0 --settle 0 -- "short message"
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 0 && $send_n -eq 1 && $read_n -eq 1 ]]; then
  echo "PASS SP19: --retries 0 でも空の入力欄を 1 回検証して成功する"
else
  echo "FAIL SP19: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi

# --- SP20: --retries 0 では入力欄に残っても再送しない ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-stuck.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 0 --settle 0 -- "short message" >/dev/null 2>&1
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 1 && $send_n -eq 1 && $read_n -eq 1 ]]; then
  echo "PASS SP20: --retries 0 では入力欄に残っても再送せず exit 1 する"
else
  echo "FAIL SP20: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi

# --- SP21: --retries 0 の read-screen 空出力は fail-open ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-missing.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 0 --settle 0 -- "short message"
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 0 && $send_n -eq 1 && $read_n -eq 1 ]]; then
  echo "PASS SP21: --retries 0 の read-screen 空出力は成功扱いにする"
else
  echo "FAIL SP21: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi

# --- SP22: --retries 0 のプロンプト行未検出は fail-open ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-no-prompt.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 0 --settle 0 -- "short message"
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 0 && $send_n -eq 1 && $read_n -eq 1 ]]; then
  echo "PASS SP22: --retries 0 のプロンプト行未検出は成功扱いにする"
else
  echo "FAIL SP22: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi

# --- SP23: --retries 1 は検証 2 回・Enter 2 回で詰まり続けたら失敗する ---
reset_logs
SCREEN_FIXTURE="$TMP/screen-stuck.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 1 --settle 0 -- "short message" >/dev/null 2>&1
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 1 && $send_n -eq 2 && $read_n -eq 2 ]]; then
  echo "PASS SP23: --retries 1 は検証 2 回・Enter 2 回で exit 1 する"
else
  echo "FAIL SP23: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi

# --- SP24: 最後の再送後の検証で入力欄が解消したら成功する ---
reset_logs
SCREEN_COUNT="$TMP/screen-count"
: > "$SCREEN_COUNT"
cat > "$TMP/bin/cmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "cmux $*" >> "$CMUX_LOG"
printf '%s\n' "cmux $*" >> "$ORDER_LOG"
if [[ "$1" == "read-screen" ]]; then
  count=0
  [[ -s "$SCREEN_COUNT" ]] && count=$(cat "$SCREEN_COUNT")
  count=$((count + 1))
  printf '%s\n' "$count" > "$SCREEN_COUNT"
  if [[ $count -eq 1 ]]; then
    cat "$TMP/screen-stuck.txt"
  else
    cat "$TMP/screen-empty.txt"
  fi
fi
exit 0
STUB
chmod +x "$TMP/bin/cmux"
SCREEN_FIXTURE="$TMP/screen-stuck.txt"
run_sp --to-surface surface:2 --label notify --outbox-dir "$TMP/outbox" \
       --retries 1 --settle 0 -- "short message"
rc=$?
send_n=$(grep -c 'cmux send-key' "$TMP/cmux.log")
read_n=$(grep -c 'read-screen' "$TMP/cmux.log")
if [[ $rc -eq 0 && $send_n -eq 2 && $read_n -eq 2 ]]; then
  echo "PASS SP24: 最後の再送後の検証で解消したら成功する"
else
  echo "FAIL SP24: rc=$rc send-key回数=$send_n read-screen回数=$read_n"; fail=1
fi
make_stubs
SCREEN_FIXTURE="$TMP/screen-empty.txt"

# --- SP25: sentinel パスが %XX エンコードされる ---
SP25_TMP=$(mktemp -d)
mkdir -p "$SP25_TMP/run" "$SP25_TMP/outbox"
# watch.sh が作るのと同じ綴りで sentinel を置く（空白 → %20）
: > "$SP25_TMP/run/ready.dispatch-my%20repo__reviewer"
: > "$SP25_TMP/agmsg-send.log"
cat > "$SP25_TMP/send.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$AGMSG_SEND_LOG"
STUB
chmod +x "$SP25_TMP/send.sh"
cat > "$SP25_TMP/cmux" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$SP25_TMP/cmux"
CMUX_BIN="$SP25_TMP/cmux" AGMSG_SEND="$SP25_TMP/send.sh" \
AGMSG_SEND_LOG="$SP25_TMP/agmsg-send.log" AGMSG_READY_DIR="$SP25_TMP/run" \
bash "$BIN" --to-surface s1 --agmsg-team 'dispatch-my repo' --agmsg-to reviewer \
  --agmsg-from parent --label t --outbox-dir "$SP25_TMP/outbox" -- hello >/dev/null 2>&1
if grep -q 'reviewer' "$SP25_TMP/agmsg-send.log"; then
  echo "PASS SP25: encoded sentinel path was found (inbox record succeeded)"
else
  echo "FAIL SP25: encoded sentinel path was not found (inbox record skipped)"; fail=1
fi
rm -rf "$SP25_TMP"

# --- SP26: agmsg-path.sh が無くても die しない ---
SP26_TMP=$(mktemp -d)
mkdir -p "$SP26_TMP/scripts" "$SP26_TMP/run" "$SP26_TMP/outbox"
cp "$BIN" "$SP26_TMP/scripts/send-prompt.sh"   # lib を持たないディレクトリへ複製
cat > "$SP26_TMP/cmux" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$SP26_TMP/cmux"
CMUX_BIN="$SP26_TMP/cmux" AGMSG_READY_DIR="$SP26_TMP/run" \
bash "$SP26_TMP/scripts/send-prompt.sh" --to-surface s1 --label t \
  --outbox-dir "$SP26_TMP/outbox" -- hello >/dev/null 2>&1
rc=$?
if [[ $rc -eq 0 ]]; then
  echo "PASS SP26: send-prompt.sh did not die without agmsg-path.sh"
else
  echo "FAIL SP26: send-prompt.sh died without agmsg-path.sh (rc=$rc)"; fail=1
fi
rm -rf "$SP26_TMP"

exit $fail
