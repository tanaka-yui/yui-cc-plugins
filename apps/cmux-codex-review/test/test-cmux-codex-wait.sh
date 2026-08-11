#!/usr/bin/env bash
# cmux-codex-wait の回帰テスト。
#
# stub の agmsg history / cmux を使い、watcher の終了条件を検証する。
# 実行: bash apps/cmux-codex-review/test/test-cmux-codex-wait.sh
#
# 守っている不変条件:
#   W1. 既定（--timeout 無指定）では壁時計で打ち切らない。codex のレビュー/実装が
#       30 分を超えても待ち続ける（従来の 1800s 打ち切りは、まだ生きている codex を
#       見捨てて親の待機を畳んでしまい、後から届く完了通知で二度と起きなくなった）
#   W2. --surface のペインが消えていたら status=gone で exit し、親を起こす
#       （無制限待機で孤児 watcher が残らないための終了条件。時間ではなく生存で判断する）
#   W3. token 検知で status=done / exit 0（wake の本筋。回帰防止）
#   W4. --timeout を明示したときだけ従来どおり status=timeout / exit 3（後方互換）
#   W6. 完了メッセージに agents=N があれば status=done の行にそれを載せる
#   W7. agents= が無ければ出力は従来どおり（後方互換）
#   W5. review / exec 2 プラグインの cmux-codex-wait は同一内容（コピー運用のドリフト防止）
#   W8. codex-parallel-lib.sh が review / exec 2 プラグインで同一内容

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../bin/cmux-codex-wait"
[[ -x "$BIN" ]] || { echo "FAIL: bin が見つからない/実行不可: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# stub agmsg history: $HIST_OUT の内容をそのまま返す（空なら未達）
cat > "$TMP/history.sh" <<'STUB'
#!/usr/bin/env bash
cat "$HIST_OUT" 2>/dev/null || true
STUB
chmod +x "$TMP/history.sh"

# stub cmux: read-screen は $SURFACE_ALIVE が 1 のときだけ成功する
cat > "$TMP/cmux" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "read-screen" ]]; then
  [[ "${SURFACE_ALIVE:-0}" == "1" ]] && { echo "screen"; exit 0; }
  echo "Error: not_found: Surface not found for the given surface_id" >&2
  exit 1
fi
exit 0
STUB
chmod +x "$TMP/cmux"

export AGMSG_HISTORY="$TMP/history.sh"
export CMUX_BIN="$TMP/cmux"
export HIST_OUT="$TMP/hist.txt"
: > "$HIST_OUT"
fail=0

# --- W3: token 検知で status=done / exit 0 ---
echo "2026-07-27 | t | codex → parent | DONE codex-review-31: レビュー完了" > "$HIST_OUT"
out=$("$BIN" t parent codex-review-31 --interval 1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "status=done"; then
  echo "PASS W3: token 検知で status=done / exit 0"
else
  echo "FAIL W3: rc=$rc out=[$out]"
  fail=1
fi

# --- W6: 完了メッセージの agents=N を status 行に載せる ---
echo "2026-08-11 | t | codex → parent | DONE codex-review-31: レビュー完了 agents=5" > "$HIST_OUT"
out=$("$BIN" t parent codex-review-31 --interval 1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "status=done token=codex-review-31 agents=5"; then
  echo "PASS W6: agents=5 を status 行に載せる"
else
  echo "FAIL W6: rc=$rc out=[$out]"
  fail=1
fi

# --- W7: agents= が無ければ出力は従来どおり（後方互換） ---
echo "2026-08-11 | t | codex → parent | DONE codex-review-31: レビュー完了" > "$HIST_OUT"
out=$("$BIN" t parent codex-review-31 --interval 1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && [[ "$(printf '%s' "$out" | tr -d '\n')" == "status=done token=codex-review-31" ]]; then
  echo "PASS W7: agents= 無しなら従来どおりの出力"
else
  echo "FAIL W7: rc=$rc out=[$out]"
  fail=1
fi

# --- W4: --timeout 明示時は従来どおり status=timeout / exit 3 ---
: > "$HIST_OUT"
out=$("$BIN" t parent tok --timeout 2 --interval 1 2>&1); rc=$?
if [[ $rc -eq 3 ]] && printf '%s' "$out" | grep -q "status=timeout"; then
  echo "PASS W4: --timeout 明示時は従来どおり打ち切る"
else
  echo "FAIL W4: rc=$rc out=[$out]"
  fail=1
fi

# --- W1: 既定では壁時計で打ち切らない（4 秒後もまだ待っている） ---
: > "$HIST_OUT"
"$BIN" t parent tok --interval 1 > "$TMP/w1.out" 2>&1 &
w1_pid=$!
sleep 4
if kill -0 "$w1_pid" 2>/dev/null; then
  echo "PASS W1: 既定（--timeout 無指定）では壁時計で打ち切らない"
  kill "$w1_pid" 2>/dev/null
  wait "$w1_pid" 2>/dev/null
else
  echo "FAIL W1: 既定で終了した rc=$? out=[$(cat "$TMP/w1.out")]"
  fail=1
fi

# --- W2: --surface が消えていたら status=gone / exit 4 ---
: > "$HIST_OUT"
out=$(SURFACE_ALIVE=0 "$BIN" t parent tok --surface surface:99 --interval 1 --liveness-interval 1 2>&1); rc=$?
if [[ $rc -eq 4 ]] && printf '%s' "$out" | grep -q "status=gone"; then
  echo "PASS W2: ペイン消滅で status=gone / exit 4"
else
  echo "FAIL W2: rc=$rc out=[$out]"
  fail=1
fi

# --- W2b: --surface が生きている間は打ち切らない ---
: > "$HIST_OUT"
SURFACE_ALIVE=1 "$BIN" t parent tok --surface surface:99 --interval 1 --liveness-interval 1 > "$TMP/w2b.out" 2>&1 &
w2b_pid=$!
sleep 4
if kill -0 "$w2b_pid" 2>/dev/null; then
  echo "PASS W2b: ペインが生きている間は待ち続ける"
  kill "$w2b_pid" 2>/dev/null
  wait "$w2b_pid" 2>/dev/null
else
  echo "FAIL W2b: 生存中に終了した out=[$(cat "$TMP/w2b.out")]"
  fail=1
fi

# --- W5: 2 プラグインの cmux-codex-wait は同一内容 ---
SIBLING="$SCRIPT_DIR/../../cmux-codex-exec/bin/cmux-codex-wait"
if [[ -f "$SIBLING" ]]; then
  if diff -q "$BIN" "$SIBLING" >/dev/null; then
    echo "PASS W5: review / exec の cmux-codex-wait が同一"
  else
    echo "FAIL W5: 2 プラグインの cmux-codex-wait が乖離している"
    diff "$BIN" "$SIBLING" | head -20
    fail=1
  fi
else
  echo "SKIP W5: cmux-codex-exec が同じリポジトリに無い"
fi

# --- W8: 2 プラグインの codex-parallel-lib.sh は同一内容 ---
LIB="$SCRIPT_DIR/../bin/codex-parallel-lib.sh"
LIB_SIBLING="$SCRIPT_DIR/../../cmux-codex-exec/bin/codex-parallel-lib.sh"
if [[ -f "$LIB" && -f "$LIB_SIBLING" ]]; then
  if diff -q "$LIB" "$LIB_SIBLING" >/dev/null; then
    echo "PASS W8: review / exec の codex-parallel-lib.sh が同一"
  else
    echo "FAIL W8: 2 プラグインの codex-parallel-lib.sh が乖離している"
    diff "$LIB" "$LIB_SIBLING" | head -20
    fail=1
  fi
else
  echo "SKIP W8: codex-parallel-lib.sh が両方には無い"
fi

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
