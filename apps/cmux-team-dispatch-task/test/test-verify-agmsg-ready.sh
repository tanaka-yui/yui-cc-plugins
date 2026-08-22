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
#   VR9.  --parent: claude 親 (CODEX_THREAD_ID 無し) は --self 相当を選ぶ
#   VR10. --parent: codex 親 (CODEX_THREAD_ID あり) + seat 記録済みは rc 0。
#         **rc 2 になってはならない** — 呼び出し側が engine 分岐を間違えると codex 親が
#         最初の起床で自滅する事故 (旧 GB8) を、分岐をスクリプト内へ畳むことで構造的に消す
#   VR11. --parent: codex 親 + seat 無しは rc 1 で reason=no-seat (no-live-watcher ではない)
#   VR12. --parent: --team はどちらの engine でも必須 (片方でだけ通る呼び出しを作らせない)
#   VR13. --parent: 同一プロジェクトに live な unfiltered watcher が居れば sharing=<N>
#         (read cursor は (team, agent) に 1 つ。先に poll した方が row を取る)
#   VR14. --parent: 別プロジェクトの unfiltered watcher は数えない
#         (RUN_DIR は install 単位、購読は project 単位)
#   VR15. --parent: filter ファイルを持たない watcher は数えない (agmsg と同じ pre-change 扱い)
#   VR16. --parent: 名前で filter 済みの watcher は数えない (購読が重ならない)
#   VR17. --parent: 自分の filter ファイルが無ければ sharing=unknown (0 と偽らない)
#   VR18. --parent: 自分が filter 済みなら sharing=0 (競合しようがない)
#   VR19. --parent: 死んだ pid の watcher は数えない

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


# ---------------------------------------------------------------------------
# --parent モード
#
# 親の readiness 判定は engine で分かれるが、その分岐を SKILL.md / guide-ja.md /
# CLAUDE.md へ書き写すと 3 箇所が同時にずれる。分岐はここに 1 つだけ置く。
# ---------------------------------------------------------------------------

# 各ケースを独立した RUN_DIR で回す。VR1-VR8 が置いた pidfile を数えないため。
parent_run() { # $1=run dir, 残りは verify-agmsg-ready.sh への引数
  local dir="$1"; shift
  AGMSG_RUN_DIR="$dir" env -u CODEX_THREAD_ID bash "$BIN" "$@" 2>&1
}
codex_run() { # $1=run dir, 残りは引数
  local dir="$1"; shift
  AGMSG_RUN_DIR="$dir" CODEX_THREAD_ID=thread-1 bash "$BIN" "$@" 2>&1
}
# $1=run dir, $2=session id, $3=filter の 1 行目 (空文字なら filter を作らない), $4=project
mk_self() {
  echo $$ > "$1/watch.$2.pid"
  [[ -n "$3" ]] && printf '%s\n%s\n%s\n' "$3" "$4" "$$" > "$1/watch.$2.filter"
  return 0
}
# $1=run dir, $2=session id, $3=filter 1 行目 (空なら作らない), $4=project, $5=pid
mk_other() {
  echo "$5" > "$1/watch.$2.pid"
  [[ -n "$3" ]] && printf '%s\n%s\n%s\n' "$3" "$4" "$5" > "$1/watch.$2.filter"
  return 0
}
check() { # $1=ラベル, $2=期待 rc, $3=期待部分文字列, $4=実 rc, $5=実出力
  if [[ "$4" -eq "$2" ]] && printf '%s' "$5" | grep -q -- "$3"; then
    echo "PASS $1"
  else
    echo "FAIL $1: rc=$4 (期待 $2) out=[$5]"; fail=1
  fi
}

# --- VR9: claude 親は --self 相当 ---
d="$TMP/vr9"; mkdir -p "$d"
mk_self "$d" sess-p unfiltered /proj/a
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR9: claude 親で ready=yes" 0 "ready=yes" "$rc" "$out"
check "VR9: sharing=0 を返す" 0 "sharing=0" "$rc" "$out"

# --- VR10: codex 親 + seat 記録済み。rc 2 は退行 ---
d="$TMP/vr10"; mkdir -p "$d"
echo "01a0-thread" > "$d/codex-bridge.t1.parent.thread"
out=$(codex_run "$d" --parent --team t1); rc=$?
check "VR10: codex 親 + seat で ready=yes" 0 "ready=yes" "$rc" "$out"
if [[ $rc -eq 2 ]]; then
  echo "FAIL VR10: codex 親へ --self 相当を投げている (rc 2 = 判定不能)"; fail=1
fi

# --- VR11: codex 親 + seat 無し ---
d="$TMP/vr11"; mkdir -p "$d"
out=$(codex_run "$d" --parent --team t1); rc=$?
check "VR11: codex 親 + seat 無しは rc 1" 1 "reason=no-seat" "$rc" "$out"

# --- VR12: --team はどちらの engine でも必須 ---
d="$TMP/vr12"; mkdir -p "$d"
mk_self "$d" sess-p unfiltered /proj/a
out=$(parent_run "$d" --parent --session-id sess-p); rc=$?
check "VR12(claude): --team 無しは rc 2" 2 "ready=no" "$rc" "$out"
out=$(codex_run "$d" --parent); rc=$?
check "VR12(codex): --team 無しは rc 2" 2 "ready=no" "$rc" "$out"

# --- VR13: 同一プロジェクトの unfiltered watcher を数える ---
d="$TMP/vr13"; mkdir -p "$d"
mk_self  "$d" sess-p unfiltered /proj/a
mk_other "$d" sess-x unfiltered /proj/a $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR13: 競合 watcher を sharing=1 と数える" 0 "sharing=1" "$rc" "$out"
check "VR13: 到達可能という判定は変えない" 0 "ready=yes" "$rc" "$out"

# --- VR14: 別プロジェクトは数えない ---
d="$TMP/vr14"; mkdir -p "$d"
mk_self  "$d" sess-p unfiltered /proj/a
mk_other "$d" sess-x unfiltered /proj/b $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR14: 別プロジェクトの watcher は数えない" 0 "sharing=0" "$rc" "$out"

# --- VR15: filter ファイル無しは数えない ---
d="$TMP/vr15"; mkdir -p "$d"
mk_self  "$d" sess-p unfiltered /proj/a
mk_other "$d" sess-x "" "" $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR15: filter 無しの watcher は数えない" 0 "sharing=0" "$rc" "$out"

# --- VR16: 名前で filter 済みは数えない ---
d="$TMP/vr16"; mkdir -p "$d"
mk_self  "$d" sess-p unfiltered /proj/a
mk_other "$d" sess-x task-exec /proj/a $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR16: 名前で filter 済みは数えない" 0 "sharing=0" "$rc" "$out"

# --- VR17: 自分の filter が無ければ unknown ---
d="$TMP/vr17"; mkdir -p "$d"
mk_self  "$d" sess-p "" ""
mk_other "$d" sess-x unfiltered /proj/a $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR17: 自分の filter 無しは sharing=unknown" 0 "sharing=unknown" "$rc" "$out"

# --- VR18: 自分が filter 済みなら競合しない ---
d="$TMP/vr18"; mkdir -p "$d"
mk_self  "$d" sess-p parent /proj/a
mk_other "$d" sess-x unfiltered /proj/a $$
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR18: 自分が filter 済みなら sharing=0" 0 "sharing=0" "$rc" "$out"

# --- VR19: 死んだ pid は数えない ---
d="$TMP/vr19"; mkdir -p "$d"
mk_self  "$d" sess-p unfiltered /proj/a
mk_other "$d" sess-x unfiltered /proj/a "$dead"
out=$(parent_run "$d" --parent --team t1 --session-id sess-p); rc=$?
check "VR19: 死んだ watcher は数えない" 0 "sharing=0" "$rc" "$out"

if [[ $fail -eq 0 ]]; then echo "--- all passed ---"; else echo "--- failures ---"; fi
exit $fail
