#!/usr/bin/env bash
# 端末の起床。**配送と起床は別の事実である。**メールボックスに入れただけでは、ターンを
# 終えた worker は動き出さない（実測 2026-09-10）。ここが「起こせたか」だけを答える。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"; : > "$ORCA_STUB_DIR/argv.log"
  WF="$ORCA_STUB_DIR/workers.json"
  jq -nc '{roles:{design:{dispatch:"ctx_d",terminal:"term_d"},
                  design_review:{dispatch:"ctx_r"}}}' > "$WF"
  echo '{"ok":true,"result":{"worker":{"state":"idle"},"dispatch":{"status":"running"}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-show"
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
}
teardown() { rm -rf "$ORCA_STUB_DIR"; unset ORCA_STUB_DIR ORCA_BIN; }
wake() { node "$P/bin/orca-wake.ts" --workers "$WF" "$@"; }
argv() { tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log"; }

# WK1: 役の端末へ --enter 付きで 1 行入力する。
setup
wake --role design >/dev/null 2>&1; rc=$?
a=$(argv)
[[ "$rc" -eq 0 ]] && grep -qxF 'terminal' <<<"$a" && grep -qxF 'send' <<<"$a" \
  && grep -qxF 'term_d' <<<"$a" && grep -qxF -- '--enter' <<<"$a" \
  && ok "WK1 端末へ入力する" || fail "WK1 (rc=$rc)"
teardown

# WK2: ★ **端末が記録されていない役は起こせない。**「止まっている」と「止まっていて
#      届かない」を別の結論として返す（cmux 版の seat 未記録と同じ切り分け）。
setup
wake --role design_review >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal send' "$ORCA_STUB_DIR/calls.log" \
  && ok "WK2 端末未記録では何も打たない" || fail "WK2 (rc=$rc)"
teardown

# WK3: ★ **終端した dispatch を叩かない。**閉じた worker の端末に入力しても意味が無く、
#      人が再利用している端末なら害がある。
setup
echo '{"ok":true,"result":{"worker":{"state":"succeeded"},"dispatch":{"status":"completed"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
wake --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal send' "$ORCA_STUB_DIR/calls.log" \
  && ok "WK3 終端した dispatch は起こさない" || fail "WK3 (rc=$rc)"
teardown

# WK4: worker-show が読めないときは打たない（生死が分からないものに触らない）。
setup
echo '{"ok":false,"error":{"code":"not_found"}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
wake --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'terminal send' "$ORCA_STUB_DIR/calls.log" \
  && ok "WK4 状態不明では起こさない" || fail "WK4 (rc=$rc)"
teardown

# WK5: ★ **rc 0 かつ ok:false の応答形がある。**receipt を見ずに成功と答えない。
setup
echo '{"ok":false,"error":{"message":"terminal is gone"}}' > "$ORCA_STUB_DIR/terminal_send"
wake --role design >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "WK5 receipt が ok でなければ失敗" || fail "WK5 (rc=$rc)"
teardown

# WK6: --text で本文を差し替えられる。既定は mailbox を読ませる 1 行。
setup
wake --role design --text 'custom nudge' >/dev/null 2>&1
grep -qxF 'custom nudge' <<<"$(argv)" && ok "WK6 本文を差し替えられる" || fail "WK6"
teardown
setup
wake --role design >/dev/null 2>&1
t=$(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" | grep 'mailbox')
# ★ **1 行であること。**`--enter` は末尾に Enter を足すだけなので、本文に改行があると
#   そこで送信され、残りが次の入力として撃ち込まれる。
[[ -n "$t" && "$(wc -l <<<"$t")" -eq 1 ]] && ok "WK6b 既定の本文は 1 行" || fail "WK6b"
teardown

# WK7: 使用法エラーは 2。
setup; wake --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "WK7 使用法エラー" || fail "WK7"; teardown
setup; node "$P/bin/orca-wake.ts" --role design >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "WK7b --workers は必須" || fail "WK7b"; teardown

# WK8: 読めない workers.json は起こせなかったとして 1（使用法エラーにしない）。
setup
node "$P/bin/orca-wake.ts" --workers "$ORCA_STUB_DIR/nope.json" --role design >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "WK8 読めない workers.json は 1" || fail "WK8"
teardown

echo "---"; [[ "$fails" -eq 0 ]] && echo "test-wake: ALL PASS" || echo "test-wake: $fails FAILED"
exit $(( fails > 0 ))
