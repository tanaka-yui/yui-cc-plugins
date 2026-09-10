#!/usr/bin/env bash
# worker 間の送信。**配送されていないのに配送されたと返さない**ことが全部である。
# 呼び出し側は「送れなかったら書いたファイルを消す」補償を行うので、ここが曖昧だと補償が壊れる。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"; : > "$ORCA_STUB_DIR/argv.log"
  export ORCA_TERMINAL_HANDLE=term_me
  WF="$ORCA_STUB_DIR/workers.json"
  jq -nc '{roles:{design:{dispatch:"ctx_d"},design_review:{dispatch:"ctx_r"}}}' > "$WF"
  printf '%s\n' '{"ok":true,"result":{"message":{"id":"msg_1"}}}' \
    > "$ORCA_STUB_DIR/orchestration_send"
}
teardown() { rm -rf "$ORCA_STUB_DIR"; unset ORCA_STUB_DIR ORCA_BIN ORCA_TERMINAL_HANDLE; }
send() { bash "$P/bin/orca-send.sh" --workers "$WF" "$@"; }
argv() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log"; }

# SN1: ロール名を dispatch: 宛先へ解決し、自分の handle を --from に載せる。
setup
out=$(send --to design_review --subject 'review-plan: round 1' --body 'please look' 2>/dev/null); rc=$?
a=$(argv)
[[ "$rc" -eq 0 && "$out" == msg_1 ]] \
  && grep -qxF -- '--to' <<<"$a" && grep -qxF 'dispatch:ctx_r' <<<"$a" \
  && grep -qxF 'term_me' <<<"$a" && grep -qxF 'review-plan: round 1' <<<"$a" \
  && grep -qxF 'status' <<<"$a" \
  && ok "SN1 ロール名を dispatch 宛先へ解決する" || fail "SN1 (rc=$rc out=$out)"
teardown

# SN2: ★ **自分の handle が取れなければ何も送らない** (spec 6-2 / O26)。
#      `--from` を省くと候補が 1 つのとき Orca は暗黙に束縛する。誤送より未送のほうがよい。
setup; unset ORCA_TERMINAL_HANDLE
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && [[ ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "SN2 sender handle が無ければ送らない" || fail "SN2 (rc=$rc)"
teardown

# SN3: 未登録のロールは未配送 (exit 1)。黙って捨てない。
setup
send --to exec_review --subject 'x' --body 'y' >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && [[ ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "SN3 未登録の宛先は未配送" || fail "SN3 (rc=$rc)"
teardown

# SN4: dispatch は在るが値が空でも送らない。
setup
jq -nc '{roles:{design_review:{dispatch:""}}}' > "$WF"
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && [[ ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "SN4 空の dispatch も未配送" || fail "SN4 (rc=$rc)"
teardown

# SN5: ★ **rc 0 でも receipt が ok でなければ未配送。**実測で「rc 0 かつ ok:false」の
#      応答形が在る (worker-release の user_takeover)。ここも同じ構えで閉じる。
setup
printf '%s\n' '{"ok":false,"error":{"code":"unavailable"}}' > "$ORCA_STUB_DIR/orchestration_send"
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "SN5 rc 0 でも ok でなければ未配送" || fail "SN5"
teardown

# SN6: ok:true でも message id が無ければ未配送とする（成功の証拠が無い）。
setup
printf '%s\n' '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_send"
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "SN6 message id が無ければ未配送" || fail "SN6"
teardown

# SN7: CLI が非 0 なら未配送。
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_send.rc"
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "SN7 CLI の非 0 は未配送" || fail "SN7"
teardown

# SN8: 使用法エラーは 2（未配送の 1 と区別する）。呼び出し側の補償が誤爆しないため。
setup
bash "$P/bin/orca-send.sh" --workers "$WF" --to design_review >/dev/null 2>&1
[[ $? -eq 2 ]] || fail "SN8 --subject 欠落"
bash "$P/bin/orca-send.sh" --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "SN8 使用法エラーは 2" || fail "SN8 unknown option"
teardown

# ── 起床 ─────────────────────────────────────────────────────────────────
# ★ **メッセージを入れただけでは相手は動かない。**`review-verdict:` も
#   `abort-reviewer:` も、ターンを終えた相手のメールボックスで滞留する（実測 2026-09-10）。
#   配送に成功したら、相手の端末も叩く。
setup
jq -nc '{roles:{design:{dispatch:"ctx_d",terminal:"term_d"},
                design_review:{dispatch:"ctx_r",terminal:"term_r"}}}' > "$WF"
echo '{"ok":true,"result":{"worker":{"state":"idle"},"dispatch":{"status":"running"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
out=$(send --to design_review --subject 'review-plan: round 1' --body 'x' 2>/dev/null); rc=$?
a=$(argv)
[[ "$rc" -eq 0 && "$out" == msg_1 ]] && grep -qxF 'term_r' <<<"$a" \
  && ok "SN9 配送に成功したら相手を起こす" || fail "SN9 (rc=$rc out=$out)"
teardown

# SN10: ★ **起こせなくても「配送された」は覆らない。**呼び出し側は exit code で
#       「書いたファイルを消す」補償を決める。起床の失敗でそれを誤らせない。
setup
jq -nc '{roles:{design_review:{dispatch:"ctx_r",terminal:"term_r"}}}' > "$WF"
echo '{"ok":false,"error":{"message":"gone"}}' > "$ORCA_STUB_DIR/terminal_send"
out=$(send --to design_review --subject 'review-plan: round 1' --body 'x' 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == msg_1 ]] \
  && ok "SN10 起床の失敗は配送を覆さない" || fail "SN10 (rc=$rc out=$out)"
teardown

# SN11: 配送できなかったときは端末も叩かない（届いていないものを読ませない）。
setup
printf '%s\n' '{"ok":false,"error":{"message":"nope"}}' > "$ORCA_STUB_DIR/orchestration_send"
send --to design_review --subject 'x' --body 'y' >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal send' "$ORCA_STUB_DIR/calls.log" \
  && ok "SN11 未配送なら起こさない" || fail "SN11 (rc=$rc)"
teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
