#!/usr/bin/env bash
# review-request.sh の回帰テスト。
#
# 守っている不変条件:
#   RQ1. 本文を stdin から受け、<point>-round-<N>-request.md へ書く
#   RQ2. 同じ本文を review-code: プレフィックス付きで send.sh へ 4 引数で渡す
#   RQ3. point=design/spec/plan (code 以外) は review-plan: プレフィックス (R-T2-6)
#   RQ4. send.sh が非ゼロなら request ファイルを削除して exit 1
#        (残すと gate が「始まっていない待機」を待機と読む)
#   RQ5. 空 stdin は exit 2 で、ファイルを 1 つも作らない
#   RQ6. 不正な point / round / agent 名は exit 2
#   RQ7. 同一ラウンドの再送は上書きし、mtime が進む
#   RQ8. 一時ファイルは *.md にマッチしない (review_select_active の走査を汚さない)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/review-request.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }

fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

SEND="$TMP/send.sh"
SEND_LOG="$TMP/send.log"
cat > "$SEND" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$#" >> "$SEND_LOG"
for a in "$@"; do printf '%s\n' "$a" >> "$SEND_LOG"; done
exit "${SEND_EXIT:-0}"
STUB
chmod +x "$SEND"

mkrd() { local d="$TMP/$1/review"; mkdir -p "$d"; printf '%s' "$d"; }
run() { AGMSG_SEND="$SEND" SEND_LOG="$SEND_LOG" bash "$BIN" "$@"; }

# --- RQ1 / RQ2 ---
rd=$(mkrd rq1)
: > "$SEND_LOG"
printf 'code review round 1: inspect the committed implementation\n' \
  | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
req="$rd/code-round-1-request.md"
if [[ $rc -eq 0 && -f "$req" ]] && grep -q 'inspect the committed implementation' "$req"; then
  pass "RQ1: request ファイルを書く"
else
  bad "RQ1: rc=$rc file=$([[ -f $req ]] && echo yes || echo no)"
fi
if [[ "$(sed -n 1p "$SEND_LOG")" == 4 \
   && "$(sed -n 2p "$SEND_LOG")" == t1 \
   && "$(sed -n 3p "$SEND_LOG")" == ex \
   && "$(sed -n 4p "$SEND_LOG")" == rev ]] \
   && sed -n 5p "$SEND_LOG" | grep -q '^review-code: code review round 1'; then
  pass "RQ2: 4 引数と review-code: プレフィックス"
else
  bad "RQ2: send.sh の引数が違う: $(tr '\n' '|' < "$SEND_LOG")"
fi

# --- RQ3 ---
rd=$(mkrd rq3)
: > "$SEND_LOG"
printf 'plan review\n' | run --review-dir "$rd" --point design --round 2 --team t1 --from d --to dr
if [[ -f "$rd/design-round-2-request.md" ]] && sed -n 5p "$SEND_LOG" | grep -q '^review-plan: plan review'; then
  pass "RQ3: design は review-plan: プレフィックス"
else
  bad "RQ3: design の経路が違う"
fi

# R-T2-6: --point は design|code の 2 値許可リストではなくなった。superpowers モードの
# Phase A-R は spec / plan という 2 つの checkpoint 名を使うので、code 以外のあらゆる
# 安全な point 名が受理され、review-plan: プレフィックスになることを確認する。
rd=$(mkrd rq3-spec)
: > "$SEND_LOG"
printf 'spec review\n' | run --review-dir "$rd" --point spec --round 1 --team t1 --from d --to dr
if [[ -f "$rd/spec-round-1-request.md" ]] && sed -n 5p "$SEND_LOG" | grep -q '^review-plan: spec review'; then
  pass "RQ3b: point=spec も review-plan: プレフィックス"
else
  bad "RQ3b: spec の経路が違う"
fi

rd=$(mkrd rq3-plan)
: > "$SEND_LOG"
printf 'plan checkpoint review\n' | run --review-dir "$rd" --point plan --round 1 --team t1 --from d --to dr
if [[ -f "$rd/plan-round-1-request.md" ]] && sed -n 5p "$SEND_LOG" | grep -q '^review-plan: plan checkpoint review'; then
  pass "RQ3c: point=plan も review-plan: プレフィックス"
else
  bad "RQ3c: plan の経路が違う"
fi

# --- RQ4 ---
rd=$(mkrd rq4)
printf 'body\n' | SEND_EXIT=1 AGMSG_SEND="$SEND" SEND_LOG="$SEND_LOG" \
  bash "$BIN" --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
if [[ $rc -eq 1 && ! -e "$rd/code-round-1-request.md" ]]; then
  pass "RQ4: 送信失敗で request ファイルを削除し exit 1"
else
  bad "RQ4: rc=$rc 残存=$([[ -e $rd/code-round-1-request.md ]] && echo yes || echo no)"
fi

# --- RQ5 ---
rd=$(mkrd rq5)
printf '   \n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
rc=$?
if [[ $rc -eq 2 && -z "$(ls -A "$rd")" ]]; then
  pass "RQ5: 空 stdin は exit 2 で何も作らない"
else
  bad "RQ5: rc=$rc 中身=$(ls -A "$rd")"
fi

# --- RQ6 ---
rd=$(mkrd rq6)
bad6=0
# R-T2-6: point の許可リストは廃止されたが、[A-Za-z0-9._-]+ 以外の文字 (シェルメタ文字や
# 空白) は依然として拒否されなければならない。
printf 'b\n' | run --review-dir "$rd" --point 'spec;rm' --round 1 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$rd" --point 'spec point' --round 1 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$rd" --point code --round 6 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$rd" --point code --round 1 --team 't 1' --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
printf 'b\n' | run --review-dir "$TMP/does-not-exist" --point code --round 1 --team t1 --from ex --to rev
[[ $? -eq 2 ]] || bad6=1
if [[ $bad6 -eq 0 && -z "$(ls -A "$rd")" ]]; then
  pass "RQ6: 不正な引数は exit 2 で何も作らない"
else
  bad "RQ6: 検証が緩い"
fi

# --- RQ7 ---
rd=$(mkrd rq7)
printf 'round 1 first\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
req="$rd/code-round-1-request.md"
before=$(stat -f %m "$req" 2>/dev/null || stat -c %Y "$req")
sleep 1.1
printf 'round 1 resend\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
after=$(stat -f %m "$req" 2>/dev/null || stat -c %Y "$req")
if grep -q 'round 1 resend' "$req" && (( after > before )); then
  pass "RQ7: 再送で上書きし mtime が進む"
else
  bad "RQ7: before=$before after=$after"
fi

# --- RQ8 ---
# 一時ファイルは review/*.md に現れない。review-state.sh は review/*.md を glob して
# <point>-round-<N>[-request|-abort].md として名前を解釈するので、書きかけの一時ファイルが
# そこへ現れると gate のレビュー状態判定が汚れる。事後条件だけでは素朴な直接書き込み実装と
# 区別できないため、mktemp の テンプレート自体も検査する。
tmpl=$(grep -o 'mktemp "[^"]*"' "$BIN" | head -1)
if [[ "$tmpl" == *'/.'* && "$tmpl" != *'.md'* ]]; then
  pass "RQ8a: mktemp テンプレートがドット始まりで .md を含まない ($tmpl)"
else
  bad "RQ8a: 一時ファイル名が review/*.md に混入しうる: $tmpl"
fi

rd=$(mkrd rq8)
printf 'body\n' | run --review-dir "$rd" --point code --round 1 --team t1 --from ex --to rev
shopt -s nullglob
mds=("$rd"/*.md)
if [[ ${#mds[@]} -eq 1 ]]; then
  pass "RQ8b: *.md にマッチするのは request ファイルだけ"
else
  bad "RQ8b: *.md が ${#mds[@]} 個ある: ${mds[*]}"
fi
shopt -u nullglob

[[ $fail -eq 0 ]] && echo "--- すべて PASS ---" || echo "--- FAIL あり ---"
exit $fail
