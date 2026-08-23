#!/usr/bin/env bash
# verify-roles-ready.sh の回帰。
#
# codex ロールは [ready] を自己申告できても、bridge seat が無ければ実際には受信できない
# (send.sh は成功するのにメッセージは未読で滞留する)。この検証は SKILL.md の地の文にしか
# 無く prewarm も実行しなかったため、親エージェントが段落を覚えていなければ飛ばされた。
# 2026-08-22 の事故では実際に飛ばされ、seat の無いペインへディスパッチが進んだ。
#
# readiness の判定そのものをここへ畳み込むことで、飛ばせなくする。
#
# 守っている不変条件:
#   RR1. ready を申告した claude ロールは ready 扱い (出力に出ない)
#   RR2. ready を申告していないロールは not-ready として出力される
#   RR3. **ready を申告した codex ロールでも seat が無ければ not-ready** (事故そのもの)
#   RR4. seat がある codex ロールは ready 扱い
#   RR5. design が not-ready なら exit 1 (fail-closed。必須ロール)
#   RR6. exec が not-ready なら exit 1
#   RR7. review ロールだけが not-ready なら exit 0 (gate をスキップするだけ)
#   RR8. 引数不正は exit 2

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/verify-roles-ready.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export AGMSG_RUN_DIR="$TMP/run"; mkdir -p "$AGMSG_RUN_DIR"
# snapshot の検証は runner registry と engine の一致まで見るので用意する
export DISPATCH_CONFIG_HOME="$TMP/home"; mkdir -p "$DISPATCH_CONFIG_HOME"
cat > "$DISPATCH_CONFIG_HOME/runners.json" <<'JSON'
{"default":"ccf","runners":[{"name":"ccf","command":"ccf","engine":"claude"},
                            {"name":"cx","command":"codex","engine":"codex"}]}
JSON
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

PW="$TMP/prewarm.json"
cat > "$PW" <<'JSON'
{"workspace_id":"workspace:1","review_mode":"on",
 "design":{"surface_id":"surface:1","agent":"t","runner":"ccf","engine":"claude","model":"opus","effort":"xhigh","wired":true},
 "design_review":{"surface_id":"surface:2","agent":"t-design-review","runner":"cx","engine":"codex","model":"gpt","effort":"xhigh","wired":true},
 "exec":{"surface_id":"surface:3","agent":"t-exec","runner":"cx","engine":"codex","model":"gpt","effort":"high","wired":true},
 "exec_review":{"surface_id":"surface:4","agent":"t-exec-review","runner":"ccf","engine":"claude","model":"opus","effort":"high","wired":true}}
JSON
seat() { printf 'thread-1\n' > "$AGMSG_RUN_DIR/codex-bridge.tm.$1.thread"; }
noseat() { rm -f "$AGMSG_RUN_DIR/codex-bridge.tm.$1.thread"; }

run() { bash "$BIN" --prewarm "$PW" --team tm "$@" 2>/dev/null; }

# --- RR1/RR4: 全員 ready + codex に seat あり ---
seat t-design-review; seat t-exec
out=$(run --ready design --ready design_review --ready exec --ready exec_review); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'RR1/RR4 全員 ready なら出力無し / exit 0' \
  || bad "RR1/RR4 rc=$rc out=[$out]"

# --- RR3: codex が ready 申告済みでも seat 無しなら not-ready ---
noseat t-design-review
out=$(run --ready design --ready design_review --ready exec --ready exec_review); rc=$?
if [[ "$out" == *"design_review"* ]]; then
  pass 'RR3 seat 無しの codex ロールは not-ready と判定される'
else
  bad "RR3 seat 無しを見逃した out=[$out]"
fi
seat t-design-review

# --- RR2: 未申告のロール ---
out=$(run --ready design --ready design_review --ready exec); rc=$?
[[ "$out" == *"exec_review"* ]] && pass 'RR2 未申告のロールが出力される' \
  || bad "RR2 out=[$out]"

# --- RR7: review だけ not-ready なら exit 0 ---
[[ $rc -eq 0 ]] && pass 'RR7 review ロールだけの not-ready は exit 0' || bad "RR7 rc=$rc"

# --- RR5: design が not-ready ---
out=$(run --ready design_review --ready exec --ready exec_review); rc=$?
[[ $rc -eq 1 && "$out" == *"design"* ]] && pass 'RR5 design が not-ready なら exit 1' \
  || bad "RR5 rc=$rc out=[$out]"

# --- RR6: exec が seat 無しで not-ready ---
noseat t-exec
out=$(run --ready design --ready design_review --ready exec --ready exec_review); rc=$?
[[ $rc -eq 1 && "$out" == *"exec"* ]] && pass 'RR6 exec が seat 無しなら exit 1' \
  || bad "RR6 rc=$rc out=[$out]"
seat t-exec

# --- RR8: 引数不正 ---
for args in "" "--prewarm $PW" "--team tm"; do
  out=$(bash "$BIN" $args 2>/dev/null); rc=$?
  [[ $rc -eq 2 ]] && pass "RR8([$args]) exit 2" || bad "RR8([$args]) rc=$rc"
done

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
