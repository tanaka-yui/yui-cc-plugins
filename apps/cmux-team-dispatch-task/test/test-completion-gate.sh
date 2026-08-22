#!/usr/bin/env bash
# completion-gate.sh の判定回帰。
#
# 守っている不変条件:
#   CG1. status が done / error なら許す
#   CG2. design は .deferred があれば許す
#   CG3. design / exec は .assigned-<agent> が無ければ許す (タスク未着)
#   CG4. review ロールは round ファイルが無ければ許す (依頼未着)
#   CG5. 依頼側は VERDICT 行が無ければ許す (verdict 待ち)
#   CG6. レビュアーは VERDICT 行が無ければ block する (まだ書いていない)
#        CG5 と CG6 は同じディスク状態に対する逆の判定である。依頼側にとって
#        「VERDICT がまだ無い」は相手待ちで正しい状態、レビュアーにとっては自分が
#        まだ書いていないという意味だからである。
#   CG7. それ以外は block する
#   CG8. block の JSON は decision / reason 以外のキーを含まない (codex の
#        additionalProperties:false に適合させるため)
#   CG9. 引数不正は exit 2 で、stdout には何も出さない
#  CG10. 連続 block には上限があり、達したら block をやめる
#        (Stop hook が永久に block すると無限ループになる。2026-08-22 の実測で、
#         engine 側に連続 block の回数上限が無いことを確認済みなので自前で持つ)
#  CG11. 停止を許したときにカウンタがリセットされる
#        (待機から復帰したあとに前の回数を持ち越さない)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/completion-gate.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

mkdir_case() { local d="$TMP/$1"; mkdir -p "$d/review"; echo "$d"; }
set_status() { jq -n --arg s "$2" '{status:$s}' > "$1/status.json"; }

# --- CG1: 終端 status は許す ---
for st in done error; do
  d=$(mkdir_case "cg1-$st"); set_status "$d" "$st"
  out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
  [[ $rc -eq 0 && -z "$out" ]] && pass "CG1($st): 終端 status で停止を許す" \
    || bad "CG1($st): rc=$rc out=[$out]"
done

# --- CG2: design の .deferred ---
d=$(mkdir_case cg2); set_status "$d" executing; : > "$d/.deferred"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG2: design は .deferred で停止を許す' \
  || bad "CG2: rc=$rc out=[$out]"

# --- CG3: タスク未着 ---
d=$(mkdir_case cg3); set_status "$d" executing
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG3: .assigned が無ければ停止を許す' \
  || bad "CG3: rc=$rc out=[$out]"

# --- CG4: 依頼未着 (review ロール) ---
d=$(mkdir_case cg4); set_status "$d" executing
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG4: round ファイルが無ければ停止を許す' \
  || bad "CG4: rc=$rc out=[$out]"

# --- CG5: 依頼側の verdict 待ち ---
d=$(mkdir_case cg5); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'findings\n' > "$d/review/code-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG5: 依頼側は VERDICT 未着で停止を許す' \
  || bad "CG5: rc=$rc out=[$out]"

# --- CG6: レビュアーは同じ状態で block ---
d=$(mkdir_case cg6); set_status "$d" executing
printf 'findings\n' > "$d/review/code-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review); rc=$?
if [[ $rc -eq 0 ]] && jq -e '.decision == "block"' >/dev/null 2>&1 <<< "$out"; then
  pass 'CG6: レビュアーは VERDICT 未記入で block する'
else
  bad "CG6: rc=$rc out=[$out]"
fi

# --- CG7: 作業途中は block ---
d=$(mkdir_case cg7); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
if [[ $rc -eq 0 ]] && jq -e '.decision == "block" and (.reason | length > 0)' \
   >/dev/null 2>&1 <<< "$out"; then
  pass 'CG7: 作業途中は block し reason を付ける'
else
  bad "CG7: rc=$rc out=[$out]"
fi

# --- CG8: 出力キーは decision / reason だけ ---
if jq -e '(keys | sort) == ["decision","reason"]' >/dev/null 2>&1 <<< "$out"; then
  pass 'CG8: 出力キーは decision / reason だけ'
else
  bad "CG8: codex が拒否するキーが混じっている: [$out]"
fi

# --- CG9: 引数不正は exit 2 で stdout 無出力 ---
for args in "" "--status-dir $TMP" "--role exec --agent a" "--status-dir $TMP --role bogus --agent a"; do
  out=$(bash "$BIN" $args 2>/dev/null); rc=$?
  [[ $rc -eq 2 && -z "$out" ]] && pass "CG9([$args]): exit 2 で stdout 無出力" \
    || bad "CG9([$args]): rc=$rc out=[$out]"
done

# --- CG10: 連続 block はカウントされ、上限で止まる ---
d=$(mkdir_case cg10); set_status "$d" executing; : > "$d/.assigned-task-exec"
blocked=0
for i in 1 2 3 4 5; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 3 ]] && pass 'CG10: 上限 3 で block が止まる' \
  || bad "CG10: block した回数が $blocked (期待 3)"

# --- CG11: 停止を許すとカウンタがリセットされる ---
d=$(mkdir_case cg11); set_status "$d" executing; : > "$d/.assigned-task-exec"
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
# verdict 待ちにして allow させる (ここでリセットされるはず)
printf 'findings\n' > "$d/review/code-round-1.md"
DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
# verdict が来た状態に戻すと、また 3 回 block できるはず
printf 'findings\nVERDICT: approve\n' > "$d/review/code-round-1.md"
blocked=0
for i in 1 2 3 4; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=3 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 3 ]] && pass 'CG11: 停止を許すとカウンタがリセットされる' \
  || bad "CG11: リセット後の block が $blocked 回 (期待 3)"

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
