#!/usr/bin/env bash
# verify-agmsg-ready.sh の回帰テスト。
#
# 実行: bash apps/cmux-team-dispatch-task/test/test-verify-agmsg-ready.sh
#
# 守っている不変条件:
#   VR1. --self: 生きている watch pid があれば ready=yes / exit 0
#   VR2. --self: pidfile はあるが pid が死んでいれば ready=no / exit 1
#        (プロセス生存まで見るのは、SIGKILL された watcher が pidfile を残すため)
#   VR3. --self: pidfile が無ければ ready=no / exit 1
#   VR4. --self: composite id (watch.<session>.<pid>.pid) でも一致する
#        (Monitor 起動時の session id は <uuid>.<pid> 形式で渡されることがある)
#   VR5. --codex: codex-bridge.<team>.<agent>.thread が非空なら ready=yes / exit 0
#   VR6. --codex: thread ファイルが無い / 空なら ready=no / exit 1
#        (V2a の未読滞留を検出する条件そのもの)
#   VR7. 引数不足・未知フラグは exit 2 (fail-fast。ready=yes を返さない)
#   VR8. delivery.sh を一切呼ばない (V2b で not running と誤報告した経路を使わない)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/verify-agmsg-ready.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export AGMSG_RUN_DIR="$TMP/run"
mkdir -p "$AGMSG_RUN_DIR"
fail=0

# --- VR1: 生きている pid ---
echo $$ > "$AGMSG_RUN_DIR/watch.sess-alive.pid"
out=$(bash "$BIN" --self --session-id sess-alive 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR1: 生きている watch pid で ready=yes"
else
  echo "FAIL VR1: rc=$rc out=[$out]"; fail=1
fi

# --- VR2: 死んでいる pid ---
# 存在し得ない pid を使う (99999 は既存の可能性があるため kill -0 で不在を確認)
dead=99999
while kill -0 "$dead" 2>/dev/null; do dead=$((dead + 1)); done
echo "$dead" > "$AGMSG_RUN_DIR/watch.sess-dead.pid"
out=$(bash "$BIN" --self --session-id sess-dead 2>&1); rc=$?
if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
  echo "PASS VR2: 死んだ pid で ready=no / exit 1"
else
  echo "FAIL VR2: rc=$rc out=[$out]"; fail=1
fi

# --- VR3: pidfile 無し ---
out=$(bash "$BIN" --self --session-id sess-missing 2>&1); rc=$?
if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
  echo "PASS VR3: pidfile 無しで ready=no / exit 1"
else
  echo "FAIL VR3: rc=$rc out=[$out]"; fail=1
fi

# --- VR4: composite id ---
echo $$ > "$AGMSG_RUN_DIR/watch.sess-comp.4242.pid"
out=$(bash "$BIN" --self --session-id sess-comp 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR4: composite id でも一致する"
else
  echo "FAIL VR4: rc=$rc out=[$out]"; fail=1
fi

# --- VR5: codex seat あり ---
echo "01a022a6-d7a8-7da2-80f5-6d2cfb32aed1" > "$AGMSG_RUN_DIR/codex-bridge.t1.agent1.thread"
out=$(bash "$BIN" --codex --team t1 --name agent1 2>&1); rc=$?
if [[ $rc -eq 0 ]] && printf '%s' "$out" | grep -q "ready=yes"; then
  echo "PASS VR5: seat 記録済みで ready=yes"
else
  echo "FAIL VR5: rc=$rc out=[$out]"; fail=1
fi

# --- VR6: codex seat 無し / 空 ---
: > "$AGMSG_RUN_DIR/codex-bridge.t1.empty.thread"
for name in noseat empty; do
  out=$(bash "$BIN" --codex --team t1 --name "$name" 2>&1); rc=$?
  if [[ $rc -eq 1 ]] && printf '%s' "$out" | grep -q "ready=no"; then
    echo "PASS VR6($name): seat 無し/空で ready=no / exit 1"
  else
    echo "FAIL VR6($name): rc=$rc out=[$out]"; fail=1
  fi
done

# --- VR7: 使用法エラー ---
for args in "" "--codex --team t1" "--self --bogus x"; do
  out=$(bash "$BIN" $args 2>&1); rc=$?
  if [[ $rc -eq 2 ]] && ! printf '%s' "$out" | grep -q "ready=yes"; then
    echo "PASS VR7([$args]): exit 2 で ready=yes を返さない"
  else
    echo "FAIL VR7([$args]): rc=$rc out=[$out]"; fail=1
  fi
done

# --- VR8: delivery.sh を呼ばない ---
# ヘッダコメントには「delivery.sh status は使わない」という重要な注記が必ず入るため、
# 非コメント行 (実行される行) だけを対象に判定する (コントローラ裁定 R3)。
if ! grep -v '^[[:space:]]*#' "$BIN" | grep -q "delivery.sh"; then
  echo "PASS VR8: delivery.sh に依存しない"
else
  echo "FAIL VR8: delivery.sh を参照している"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "--- all passed ---"; else echo "--- failures ---"; fi
exit $fail
