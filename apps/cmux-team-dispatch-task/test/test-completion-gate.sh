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
#  CG10. DISPATCH_GATE_MAX_BLOCKS に正の数を入れたときだけ上限が働き、達したら
#        block をやめる (既定は無制限。CG14 を参照)
#  CG11. 停止を許したときにカウンタがリセットされる
#        (待機から復帰したあとに前の回数を持ち越さない)
#  CG14. 既定 (env 未設定) では上限が無く、block し続ける
#        (有限の上限は、まだ終わっていない長いタスクを永久停止させる。2026-08-25 に
#         上限 10 に達した exec が毎ターン止まって進まなくなるのを実ペインで観測した)
#  CG15. カウンタはロールごとに独立している
#        (4 ロールが 1 つの status dir を共有するので、1 ファイルに数えると
#         「4 ペイン合計で上限」になり、どのペインも自分の回数の前に諦める)

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

# --- CG12: reason はスクリプトが知っている値を含む ---
# reason は次ターンのガイダンスとして機能するので、status dir や agent を書かないと
# 子がそれらを探し回る (実ペイン E2E で観測した退行)。
d=$(mkdir_case cg12); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec --team demo-team \
  --send-command /x/send.sh 2>/dev/null)
reason=$(jq -r '.reason // ""' <<< "$out" 2>/dev/null)
cg12=1
for needle in "$d/status.json" "report-status.sh" "task-exec" "demo-team" "/x/send.sh demo-team task-exec parent"; do
  [[ "$reason" == *"$needle"* ]] || { bad "CG12 reason に $needle が無い: [$reason]"; cg12=0; }
done
[[ $cg12 -eq 1 ]] && pass 'CG12: reason が status dir / report-status.sh / agent / team を含む'

# --- CG13: team が無いときは team を騙らせない ---
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // ""' <<< "$out" 2>/dev/null)
[[ "$reason" != *"team "* ]] && pass 'CG13: team 未指定なら reason で team に触れない' \
  || bad "CG13 team を捏造させうる文面がある: [$reason]"

# --- CG9: identity 欠落は fail-open、値が不正なら exit 2。どちらも stdout 無出力 ---
# identity が揃わないのは「この gate を書いた dispatch の管理外で実行された」状態である。
# 同じ worktree を開いた手動セッションでも共有 Stop hook は発火するので、ここで縛ると
# 無関係のペインを無期限に拘束する。Claude Code の Stop hook では exit 2 が blocking error
# なので、fail-open にしたいなら exit 0 でなければならない。
for args in "" "--status-dir $TMP" "--role exec --agent a"; do
  out=$(env -u DISPATCH_GATE_STATUS_DIR -u DISPATCH_GATE_ROLE -u DISPATCH_GATE_AGENT \
    bash "$BIN" $args 2>/dev/null); rc=$?
  [[ $rc -eq 0 && -z "$out" ]] && pass "CG9([$args]): identity 欠落は exit 0 で stdout 無出力" \
    || bad "CG9([$args]): rc=$rc out=[$out]"
done
# identity は揃っているが role の値が不正 = 明確な設定ミスなので usage error のまま。
out=$(bash "$BIN" --status-dir "$TMP" --role bogus --agent a 2>/dev/null); rc=$?
[[ $rc -eq 2 && -z "$out" ]] && pass 'CG9(bogus role): exit 2 で stdout 無出力' \
  || bad "CG9(bogus role): rc=$rc out=[$out]"

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

# --- CG14: 既定では上限が無く、block し続ける ---
d=$(mkdir_case cg14); set_status "$d" executing; : > "$d/.assigned-task-exec"
blocked=0
for i in $(seq 1 25); do
  out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 25 ]] && pass 'CG14: 既定では上限が無く block し続ける' \
  || bad "CG14: 25 回中 block したのは $blocked 回 (期待 25)"

# --- CG15: カウンタはロールごとに独立 ---
# 上限 2 で exec と design を交互に叩く。カウンタが共有なら合計 2 回で尽きる。
d=$(mkdir_case cg15); set_status "$d" executing
: > "$d/.assigned-task-exec"; : > "$d/.assigned-task"
exec_blocked=0; design_blocked=0
for i in 1 2 3; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=2 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && exec_blocked=$((exec_blocked + 1))
  out=$(DISPATCH_GATE_MAX_BLOCKS=2 bash "$BIN" --status-dir "$d" --role design --agent task 2>/dev/null)
  [[ -n "$out" ]] && design_blocked=$((design_blocked + 1))
done
[[ "$exec_blocked" == 2 && "$design_blocked" == 2 ]] \
  && pass 'CG15: カウンタはロールごとに独立している' \
  || bad "CG15: exec=$exec_blocked design=$design_blocked (期待 2/2)"

# --- CG16: 依頼文は round ファイルとして選ばれない ---
# 依頼文には手順説明として "VERDICT: approve" が普通に含まれる。これを findings と誤認すると
# 「verdict 済み」と判断される (2026-08-24 実測)。
# round 番号を変えてあるのは意図的である。同じ番号だと "-" < "." で依頼文の方が辞書順で先に
# 来てしまい、名前順の実装でも偶然 findings が選ばれるのでテストが差を検出できない。
# レビュアー視点で見るのも意図的で、VERDICT の有無に対する判定が依頼側と逆になるため、
# 「依頼文を拾った = allow」「findings を拾った = block」と結果がはっきり分かれる。
d=$(mkdir_case cg16); set_status "$d" executing
printf 'findings\n' > "$d/review/code-round-1.md"
printf 'instructions\nVERDICT: approve\n' > "$d/review/code-round-2-request.md"
touch -t 202608260800 "$d/review/code-round-1.md"
touch -t 202608260900 "$d/review/code-round-2-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review 2>/dev/null)
[[ -n "$out" ]] && pass 'CG16: 依頼文を findings と誤認しない' \
  || bad "CG16: 依頼文の VERDICT を拾ってレビュー未完了のまま allow した"

# --- CG17: checkpoint をまたぐと辞書順では壊れる。mtime で選ぶ ---
# 辞書順では plan-round-1.md < spec-round-5.md なので、完了済みの spec を選んでしまう。
d=$(mkdir_case cg17); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'findings\nVERDICT: approve\n' > "$d/review/spec-round-5.md"
printf 'findings\n' > "$d/review/plan-round-1.md"
touch -t 202608260800 "$d/review/spec-round-5.md"
touch -t 202608260900 "$d/review/plan-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG17: 進行中の checkpoint を mtime で選ぶ' \
  || bad "CG17: 完了済み checkpoint を選んで block した: [$out]"

# --- CG18: .escalated は全ロールで停止を許す ---
# ラウンド上限で parent へ引き渡した子は、done も error も虚偽になる。待つのが正しい。
for role in design design_review exec exec_review; do
  d=$(mkdir_case "cg18-$role"); set_status "$d" executing
  : > "$d/.assigned-task-exec"; : > "$d/.assigned-task"
  printf 'findings\nVERDICT: needs_work\n' > "$d/review/code-round-1.md"
  : > "$d/.escalated"
  out=$(bash "$BIN" --status-dir "$d" --role "$role" --agent task-exec 2>/dev/null)
  [[ -z "$out" ]] && pass "CG18($role): .escalated で停止を許す" \
    || bad "CG18($role): block した: [$out]"
done

# --- CG19: --send-command 省略時は .send-command から読む ---
# hook のコマンド文字列に send.sh の実パスを焼くと agmsg が自分の Stop と誤認し、
# codex の app-server bridge が起動しなくなる。だからファイル経由で渡す (2026-08-24 実測)。
d=$(mkdir_case cg19); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf '/tmp/fake-send.sh\n' > "$d/.send-command"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec --team myteam 2>/dev/null)
reason=$(jq -r '.reason // ""' <<< "$out" 2>/dev/null)
[[ "$reason" == *"/tmp/fake-send.sh myteam task-exec parent"* ]] \
  && pass 'CG19: .send-command から送信コマンドを読む' \
  || bad "CG19: reason に送信コマンドが無い: [$reason]"

# --- CG20: identity をプロセス環境から読む ---
# hook の command は 4 ロールで共有される 1 本なので、ロールは環境から来なければならない。
d=$(mkdir_case cg20); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=exec DISPATCH_GATE_AGENT=task-exec \
  bash "$BIN" 2>/dev/null)
[[ -n "$out" ]] && pass 'CG20: 環境変数だけで identity を解決する' \
  || bad "CG20: 環境変数から解決できず block しなかった"

# --- CG21: 同じ status dir でもロールごとに別の判定になる ---
# これが不具合の核心である。1 本の共有 command で 2 ロールが正しく分岐すること。
d=$(mkdir_case cg21); set_status "$d" executing
: > "$d/.assigned-task"            # design にはタスクが来ている
printf 'findings\n' > "$d/review/code-round-1.md"   # VERDICT 未記入
# design (依頼側): verdict 待ちなので停止を許す
out_d=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=task \
  bash "$BIN" 2>/dev/null)
# exec_review (レビュアー): 自分がまだ書いていないので block
out_r=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=exec_review DISPATCH_GATE_AGENT=task-exec-review \
  bash "$BIN" 2>/dev/null)
[[ -z "$out_d" && -n "$out_r" ]] && pass 'CG21: 共有 command でもロールごとに分岐する' \
  || bad "CG21: design=[$out_d] exec_review=[$out_r] (期待 allow/block)"

# --- CG22: 引数は環境変数より優先される ---
d=$(mkdir_case cg22); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(DISPATCH_GATE_STATUS_DIR=/nonexistent DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=other \
  bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // ""' <<< "$out" 2>/dev/null)
[[ "$reason" == *"$d"* ]] && pass 'CG22: 引数が環境変数を上書きする' \
  || bad "CG22: 引数が効いていない: [$reason]"

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
