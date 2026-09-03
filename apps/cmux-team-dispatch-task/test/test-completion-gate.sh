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
#  CG14. 依頼文 (*-round-<N>-request.md) を round ファイルとして拾わない
#        (依頼文には手順説明として行頭 "VERDICT: approve" が入るので、拾うと
#         verdict 済みと誤判定して、待っているだけの依頼側を block してしまう)
#  CG15. checkpoint をまたぐとき、名前順ではなく最後に依頼されたラウンドを選ぶ
#        (spec が approve 済み / plan が進行中のとき、辞書順では
#         plan-round-1.md < spec-round-5.md なので完了済みの spec を選んでしまう)
#  CG16. .escalated があれば許す (parent へ判断を引き渡して待っている状態)
#  CG17. 既定では上限が無く block し続ける
#        (有限の上限は、まだ終わっていない長いタスクを永久停止させる。2026-08-25 に
#         上限 10 に達した exec が毎ターン止まって進まなくなるのを実ペインで観測した)
#  CG18. カウンタはロールごとに独立している
#  CG19. identity をプロセス環境から解決する
#  CG20. 同じ status dir でもロールごとに判定が分かれる (共有 command の要件)
#  CG21. 引数は環境変数より優先される
#  CG22. 依頼を出したが findings がまだ無い間、依頼側は許される
#        (2026-08-26 実測: レビュー依頼中の design が毎ターン判定 7 に落ちていた)
#  CG23. 次ラウンドの依頼中も依頼側は許される (findings は前ラウンドの VERDICT 付き)
#  CG24. 同じ状態でレビュアーは block される (書く側なので判定が逆になる)
#  CG25. 次ラウンドの依頼が来たらレビュアーは再び block される
#  CG26. コードレビューの依頼中も実装者は許される (Phase A-R と同じ扱い)
#        (2026-08-28 実測: Phase B-R が request ファイルを書かないため、verdict を待つ
#         exec が判定 7 に落ち、110 秒で block 文面が勧める error を書いて中断した)
#  CG27. 判定 7 の reason が「待機は error ではない」ことと待機の materialize 手順を持つ
#        (request ファイルを書き忘れた待機者に error の逃げ道だけを見せない保険)
#  CG28. 依頼側が打ち切ったラウンド (-abort.md が最新) ではレビュアーの停止を許す
#        (中断記録を findings のパスへ書かせるのをやめる代わりに、解放をゲートが担う)
#  CG29. -abort.md を findings として拾わない (拾うと verdict 済みに見える)
#        ラウンド上限に達した子は .assigned が残り最新 round に VERDICT があるため、
#        この sentinel が無いと判定 7 に落ち、done/error のどちらを書いても虚偽になる
#  CG-P2. design ロールは code point のファイルで待機しない
#        (code のレビューは exec の仕事である。design がそれを自分の待機と誤読すると、
#         委譲後の設計ペインが exec のレビュー中ずっと停止できてしまう)
#  CG-P3. design が自分の point で待機しているとき、より新しい code の VERDICT 付き
#        findings に隠されない (2026-09-02 の F1 の design 側)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/completion-gate.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

mkdir_case() { local d="$TMP/$1"; mkdir -p "$d/review"; echo "$d"; }
set_status() {
  jq -n --arg s "$2" '{status:$s}' > "$1/status.json"
  jq -n '{exec:{agent:"task-exec"}}' > "$1/prewarm.json"
}

# --- CG1: 終端 status は許す ---
for st in done error; do
  d=$(mkdir_case "cg1-$st"); set_status "$d" "$st"
  out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec); rc=$?
  [[ $rc -eq 0 && -z "$out" ]] && pass "CG1($st): 終端 status で停止を許す" \
    || bad "CG1($st): rc=$rc out=[$out]"
done

# --- CG2: design は委譲が記録されていれば .deferred で停止を許す ---
d=$(mkdir_case cg2); set_status "$d" executing
: > "$d/.assigned-task-design"; : > "$d/.assigned-task-exec"; : > "$d/.deferred"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG2: 委譲が記録された design は停止できる' \
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
out=$(env -u DISPATCH_GATE_TEAM bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
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

# --- CG14: 依頼文を round ファイルとして拾わない ---
# 依頼文にはレビュアーへの手順説明として行頭 "VERDICT: approve" が入る (実物と同じ形にする)。
# これを findings と取り違えると、verdict を待っているだけの依頼側が「作業途中」と
# 判定されて block される。依頼文が mtime でも名前順でも「最後」になる配置にして、
# 除外フィルタ単独を検証する (CG15 の mtime 修正に助けられて通らないようにする)。
# point は role の scope (ここでは exec なので code) と一致させる — exec は design 側の
# point 名を持たないので、fixture を design 側の名前で書くと scope 済みの gate では
# そもそも候補に入らず、この不変条件を検証できなくなる。
d=$(mkdir_case cg14); touch "$d/.assigned-task-exec"
printf '（レビュー結果をここに記入）\n' > "$d/review/code-round-1.md"
sleep 1
printf '最終行を次のいずれかにすること:\nVERDICT: approve\n' \
  > "$d/review/code-round-5-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG14: 依頼文を拾わず verdict 待ちとして許す' \
  || bad "CG14: block された (rc=$rc out=[$out])"

# --- CG15: checkpoint をまたぐとき最後に依頼されたラウンドを選ぶ ---
# spec が approve 済み、plan が進行中。辞書順なら spec-round-5.md が最後になるが、
# 実際に待っているのは plan-round-1.md である。
d=$(mkdir_case cg15); set_status "$d" executing; touch "$d/.assigned-task-design"
printf 'findings\nVERDICT: approve\n' > "$d/review/spec-round-5.md"
sleep 1   # mtime を確実に分ける (秒単位の精度しか無い環境があるため)
printf '（レビュー結果をここに記入）\n' > "$d/review/plan-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG15: 進行中の plan ラウンドを選び verdict 待ちとして許す' \
  || bad "CG15: 完了済みの spec を選んで block した (rc=$rc out=[$out])"

# 逆向き: レビュアー側は同じ状態で block される (まだ VERDICT を書いていない)
out=$(bash "$BIN" --status-dir "$d" --role design_review --agent task-design-review 2>/dev/null)
echo "$out" | grep -q 'plan-round-1.md' \
  && pass 'CG15b: レビュアーは進行中の plan ラウンドを指して block する' \
  || bad "CG15b: reason が plan-round-1.md を指していない: [$out]"

# --- CG16: parent へ引き渡して判断待ちなら許す ---
# ラウンド上限に達した状態を再現する: .assigned あり / 最新 round に VERDICT あり /
# .deferred 無し。sentinel が無ければ判定 7 で block されることまで対で確認する。
d=$(mkdir_case cg16); set_status "$d" executing; touch "$d/.assigned-task-design"
printf 'findings\nVERDICT: needs_work\n' > "$d/review/plan-round-5.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -n "$out" ]] && pass 'CG16a: sentinel 無しなら block する (判定 7)' \
  || bad 'CG16a: sentinel 無しでも block されない'

touch "$d/.escalated"; rm -f "$d/.gate-blocks"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG16b: .escalated があれば引き渡し待ちとして許す' \
  || bad "CG16b: block された (rc=$rc out=[$out])"

# ロール非依存であること (exec もレビュー上限で同じ状態になりうる)
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-design 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$out" ]] && pass 'CG16c: .escalated は exec ロールでも効く' \
  || bad "CG16c: exec で block された (rc=$rc out=[$out])"

# --- CG17: 既定では上限が無く block し続ける ---
d=$(mkdir_case cg17); set_status "$d" executing; : > "$d/.assigned-task-exec"
blocked=0
for i in $(seq 1 25); do
  out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && blocked=$((blocked + 1))
done
[[ "$blocked" == 25 ]] && pass 'CG17: 既定では上限が無く block し続ける' \
  || bad "CG17: 25 回中 block したのは $blocked 回 (期待 25)"

# --- CG18: カウンタはロールごとに独立 ---
# 上限 2 で exec と design を交互に叩く。カウンタが共有なら合計 2 回で尽きる。
d=$(mkdir_case cg18); set_status "$d" executing
: > "$d/.assigned-task-exec"; : > "$d/.assigned-task"
exec_blocked=0; design_blocked=0
for i in 1 2 3; do
  out=$(DISPATCH_GATE_MAX_BLOCKS=2 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
  [[ -n "$out" ]] && exec_blocked=$((exec_blocked + 1))
  out=$(DISPATCH_GATE_MAX_BLOCKS=2 bash "$BIN" --status-dir "$d" --role design --agent task 2>/dev/null)
  [[ -n "$out" ]] && design_blocked=$((design_blocked + 1))
done
[[ "$exec_blocked" == 2 && "$design_blocked" == 2 ]] \
  && pass 'CG18: カウンタはロールごとに独立している' \
  || bad "CG18: exec=$exec_blocked design=$design_blocked (期待 2/2)"

# --- CG19: identity をプロセス環境から読む ---
# hook の command は 4 ロールで共有される 1 本なので、ロールは環境から来なければならない。
d=$(mkdir_case cg19); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=exec DISPATCH_GATE_AGENT=task-exec \
  bash "$BIN" 2>/dev/null)
[[ -n "$out" ]] && pass 'CG19: 環境変数だけで identity を解決する' \
  || bad "CG19: 環境変数から解決できず block しなかった"

# --- CG20: 同じ status dir でもロールごとに別の判定になる ---
# これが不具合の核心である。1 本の共有 command で 2 ロールが正しく分岐すること。
# 依頼側 (design) と レビュアー側 (design_review) は同じ point を共有するので、この対比
# (依頼側は未完了 findings で待てる / レビュアーは block される) はロールが point を
# 共有するペアでなければ検証できない。design と exec_review は point を共有しない。
d=$(mkdir_case cg20); set_status "$d" executing
: > "$d/.assigned-task"
printf 'findings\n' > "$d/review/plan-round-1.md"
out_d=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=task \
  bash "$BIN" 2>/dev/null)
out_r=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=design_review DISPATCH_GATE_AGENT=task-design-review \
  bash "$BIN" 2>/dev/null)
[[ -z "$out_d" && -n "$out_r" ]] && pass 'CG20: 共有 command でもロールごとに分岐する' \
  || bad "CG20: design=[$out_d] design_review=[$out_r] (期待 allow/block)"

# --- CG21: 引数は環境変数より優先される ---
d=$(mkdir_case cg21); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(DISPATCH_GATE_STATUS_DIR=/nonexistent DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=other \
  bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // ""' <<< "$out" 2>/dev/null)
[[ "$reason" == *"$d"* ]] && pass 'CG21: 引数が環境変数を上書きする' \
  || bad "CG21: 引数が効いていない: [$reason]"

# --- CG22: 依頼直後 (findings 未作成) は依頼側を許す ---
# round-<N>.md フィルタが依頼文を除外するので ROUND_FILE は空になる。判定 5 は findings が
# 存在する前提なのでここを拾えず、判定 7 に落ちて「terminal status を書け」と迫られていた。
d=$(mkdir_case cg22); set_status "$d" executing; : > "$d/.assigned-task"
printf 'request\n' > "$d/review/plan-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task 2>/dev/null)
[[ -z "$out" ]] && pass 'CG22: 依頼直後は依頼側を許す' \
  || bad "CG22: 依頼待ちなのに block された: [$out]"

# --- CG23: 次ラウンドの依頼中も依頼側を許す ---
# ROUND_FILE は round 1 の findings (VERDICT 済み) を指すため、判定 5 も成立しない。
d=$(mkdir_case cg23); set_status "$d" executing; : > "$d/.assigned-task"
printf 'findings\nVERDICT: needs_work\n' > "$d/review/plan-round-1.md"
printf 'request\n' > "$d/review/plan-round-2-request.md"
touch -t 202608260800 "$d/review/plan-round-1.md"
touch -t 202608260900 "$d/review/plan-round-2-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task 2>/dev/null)
[[ -z "$out" ]] && pass 'CG23: 次ラウンド依頼中も依頼側を許す' \
  || bad "CG23: 依頼待ちなのに block された: [$out]"

# --- CG24: 同じ状態でレビュアーは block される ---
# 依頼文しか無い区間で許すと、レビューを一度も書かないまま止まれてしまう。
d=$(mkdir_case cg24); set_status "$d" executing
printf 'request\n' > "$d/review/plan-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design_review --agent task-design-review 2>/dev/null)
[[ -n "$out" ]] && pass 'CG24: 依頼直後のレビュアーは block される' \
  || bad "CG24: レビュー未着手なのに allow された"

# --- CG25: 次ラウンドの依頼が来たらレビュアーは再び block される ---
d=$(mkdir_case cg25); set_status "$d" executing
printf 'findings\nVERDICT: needs_work\n' > "$d/review/plan-round-1.md"
printf 'request\n' > "$d/review/plan-round-2-request.md"
touch -t 202608260800 "$d/review/plan-round-1.md"
touch -t 202608260900 "$d/review/plan-round-2-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design_review --agent task-design-review 2>/dev/null)
[[ -n "$out" ]] && pass 'CG25: 次ラウンド依頼でレビュアーは再び block される' \
  || bad "CG25: 前ラウンドの VERDICT で allow された"

# --- CG26: コードレビュー依頼中の実装者を許す ---
# 2026-08-28 実測: Phase B-R は依頼を agmsg メッセージだけで送り、request ファイルを
# 一切書かなかった。そのため round 2 以降の verdict を待つ exec は ROUND_FILE が前ラウンドの
# VERDICT 付き findings を指したままになり、REQUEST_FILE は設計フェーズの古い依頼文のまま
# 動かず、判定 7 に落ちて毎ターン block された。依頼から 110 秒で子は block 文面が勧める
# error を書いて中断した。依頼が request ファイルとして materialize されていれば許される。
d=$(mkdir_case cg26); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/plan-round-4-request.md"
printf 'findings\nVERDICT: needs_work\n' > "$d/review/code-round-2.md"
printf 'request\n' > "$d/review/code-round-3-request.md"
touch -t 202608281644 "$d/review/plan-round-4-request.md"
touch -t 202608281936 "$d/review/code-round-2.md"
touch -t 202608282133 "$d/review/code-round-3-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG26: コードレビュー依頼中の実装者を許す' \
  || bad "CG26: verdict 待ちなのに block された: [$out]"

# --- CG27: 判定 7 は待機を error と取り違えさせない ---
# 判定 7 の reason は「詰まっているなら error を書け」と教える。request ファイルを書き忘れた
# 待機者はこの逃げ道を取って中断する (2026-08-28 の事故そのもの)。reason 自身が、待機は
# error ではないことと、待機を materialize する手順を持たなければならない。
d=$(mkdir_case cg27); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'findings\nVERDICT: needs_work\n' > "$d/review/code-round-2.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // empty' <<< "$out" 2>/dev/null)
if [[ "$reason" == *'-request.md'* && "$reason" == *'not'*'error'* ]]; then
  pass 'CG27: 判定 7 の reason が待機と error を切り分ける'
else
  bad "CG27: reason に待機の逃がし方が無い: [$reason]"
fi

# --- CG28: 依頼側が打ち切ったラウンドはレビュアーを縛らない ---
# 中断記録を findings のパス (code-round-N.md) へ書かせていたのは、レビュアーのゲートを
# 解放するためでもあった。記録を -abort.md へ逃がすなら、その解放をゲート側が引き受ける
# 必要がある。引き受けないと、書きかけの findings を抱えたレビュアーが永久に block される。
d=$(mkdir_case cg28); set_status "$d" executing
printf 'request\n' > "$d/review/code-round-3-request.md"
printf 'partial findings\n' > "$d/review/code-round-3.md"
printf 'requester stopped\n' > "$d/review/code-round-3-abort.md"
touch -t 202608282133 "$d/review/code-round-3-request.md"
touch -t 202608282134 "$d/review/code-round-3.md"
touch -t 202608282135 "$d/review/code-round-3-abort.md"
out=$(bash "$BIN" --status-dir "$d" --role exec_review --agent task-exec-review 2>/dev/null)
[[ -z "$out" ]] && pass 'CG28: 打ち切られたラウンドのレビュアーを許す' \
  || bad "CG28: 打ち切り後も block された: [$out]"

# --- CG29: 中断記録を findings として読まない ---
# -abort.md を round ファイルとして拾うと、依頼側が打ち切っただけで「verdict が出た」
# ことになり、次ラウンドの待機判定が壊れる。
d=$(mkdir_case cg29); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'findings\nVERDICT: needs_work\n' > "$d/review/code-round-2.md"
printf 'stopped\n' > "$d/review/code-round-2-abort.md"
printf 'request\n' > "$d/review/code-round-3-request.md"
touch -t 202608281936 "$d/review/code-round-2.md"
touch -t 202608281937 "$d/review/code-round-2-abort.md"
touch -t 202608282133 "$d/review/code-round-3-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG29: 中断記録を findings と取り違えない' \
  || bad "CG29: 依頼中なのに block された: [$out]"

# --- CG30: 待機の 1 回目は必ず許す (素の待機を block へ倒さない) ---
# engine が自動再開しない環境では、待機中の Stop は verdict が届くまで 1 回しか来ない。
# その 1 回を block すると、正しく眠れていたペインを起こして回すことになる。
d=$(mkdir_case cg30); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG30: 待機の 1 回目は許す' \
  || bad "CG30: 1 回目から block された: [$out]"

# --- CG31: 自動再開された待機は block し、abort ではなく待機を指示する ---
# codex の goal 継続はターン終了の数十ミリ秒後に新しいターンを注入する。2026-08-31 の実測で
# 待機が 81 秒 / 111 秒で abort に化けた。ゲートが待機中のターンに発言できる唯一の形が block。
d=$(mkdir_case cg31); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null)
if [[ -n "$reason" ]] \
  && echo "$reason" | grep -q 'update_goal' \
  && echo "$reason" | grep -q 'NOT a timer firing' \
  && echo "$reason" | grep -qi 'do not write an abort file'; then
  pass 'CG31: 自動再開された待機を block し abort を禁じる'
else
  bad "CG31: reason が待機防衛になっていない: [$out]"
fi

# --- CG32: 猶予を使い切った待機は block して回復手順を示す ---
# 3.8.0 では、goals=false の待機を allow に戻して黙らない。
d=$(mkdir_case cg32); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
touch -t 202601010000 "$d/review/code-round-1-request.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // empty' <<< "$out" 2>/dev/null)
[[ "$reason" == *'past the'* && "$reason" == *"$d/review/code-round-1-abort.md"* ]] \
  && pass 'CG32: 猶予切れの待機は block して回復手順を示す' \
  || bad "CG32: 回復手順を示す block でない: [$out]"

# --- CG33: 間隔が空いた再訪は自動再開と見なさない ---
# 正常に眠っていて別の理由 (verdict 以外のメッセージなど) で起きた場合まで縛らない。
d=$(mkdir_case cg33); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
echo $(( $(date +%s) - 600 )) > "$d/.gate-seen-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG33: 間隔の空いた再訪は許す' \
  || bad "CG33: 自動再開でないのに block された: [$out]"

# --- CG34: 待機防衛は無効化できる ---
d=$(mkdir_case cg34); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
DISPATCH_GATE_WAIT_MINUTES=0 bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
out=$(DISPATCH_GATE_WAIT_MINUTES=0 bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG34: DISPATCH_GATE_WAIT_MINUTES=0 で待機防衛を切れる' \
  || bad "CG34: 無効化しても block された: [$out]"

# --- CG35: 待機が終わればスタンプが消える ---
# 消し忘れると、次の待機の 1 回目が「自動再開」と誤判定される。
d=$(mkdir_case cg35); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
[[ -f "$d/.gate-wait-exec" ]] || bad 'CG35: 待機中にスタンプが作られない'
printf 'findings\nVERDICT: approve\n' > "$d/review/code-round-1.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
[[ "$(jq -r '.generation // empty' "$d/.gate-wait-exec" 2>/dev/null)" == 'progress|exec|task-exec' ]] \
  && pass 'CG35: 待機終了後は進捗 lease へ切り替わる' \
  || bad "CG35: 進捗 lease へ切り替わらない: [$(cat "$d/.gate-wait-exec" 2>/dev/null)]"
[[ ! -f "$d/.gate-seen-exec" ]] && pass 'CG35b: 判定 7 は古い待機スタンプを消す' \
  || bad 'CG35b: 次の待機を自動再開と誤判定する stamp が残った'
printf 'request 2\n' > "$d/review/code-round-2-request.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG35c: 直後の新規待機も最初は allow' \
  || bad "CG35c: 素の待機を block した: [$out]"

# --- CG36: 未依頼のコードレビューを判定 7 の reason が名指しする ---
# Phase B-R の配線が phase-b-exec メッセージの本文にしか無いと、設計ペインが自作の
# 引き継ぎ文を送った瞬間に消える。2026-08-31 実測 (lead-psp-liff の member): 実装者は
# レビュアーの存在を知る手段が無く、parent へレビューを依頼した。ゲートは
# code-review.json を読めるので、止まろうとした瞬間に agent 名を渡す。
d=$(mkdir_case cg36); set_status "$d" executing; : > "$d/.assigned-task-exec"
jq -n '{reviewer_agent:"task-exec-review", reviewer_engine:"claude"}' > "$d/review/code-review.json"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null)
if [[ -n "$reason" ]] \
  && echo "$reason" | grep -q 'task-exec-review' \
  && echo "$reason" | grep -q 'never to parent' \
  && echo "$reason" | grep -q 'review-code:'; then
  pass 'CG36: 未依頼のコードレビューでレビュアー名を渡す'
else
  bad "CG36: reason がレビュアーを名指ししない: [$out]"
fi

# --- CG37: 依頼済みなら追記しない (経路は既に伝わっている) ---
d=$(mkdir_case cg37); set_status "$d" executing; : > "$d/.assigned-task-exec"
jq -n '{reviewer_agent:"task-exec-review"}' > "$d/review/code-review.json"
printf 'request\n' > "$d/review/code-round-1-request.md"
printf 'findings\nVERDICT: approve\n' > "$d/review/code-round-1.md"
touch -t 202608311000 "$d/review/code-round-1-request.md"
touch -t 202608311001 "$d/review/code-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null)
if [[ -n "$reason" ]] && ! echo "$reason" | grep -q 'have not requested it once'; then
  pass 'CG37: 依頼済みならレビュー追記を出さない'
else
  bad "CG37: 依頼済みなのに未依頼扱いされた: [$out]"
fi

# --- CG38: レビュー未配線なら追記しない ---
d=$(mkdir_case cg38); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null)
if [[ -n "$reason" ]] && ! echo "$reason" | grep -q 'mandatory code review is wired'; then
  pass 'CG38: review_mode=off 相当ではレビュー追記を出さない'
else
  bad "CG38: 配線が無いのにレビューを迫った: [$out]"
fi

# --- CG39: design ロールへは出さない (コードレビューは実装者の義務) ---
d=$(mkdir_case cg39); set_status "$d" executing; : > "$d/.assigned-task-design"
jq -n '{reviewer_agent:"task-exec-review"}' > "$d/review/code-review.json"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
reason=$(echo "$out" | jq -r '.reason // empty' 2>/dev/null)
if [[ -n "$reason" ]] && ! echo "$reason" | grep -q 'mandatory code review is wired'; then
  pass 'CG39: design ロールにはコードレビューを迫らない'
else
  bad "CG39: design にコードレビューを迫った: [$out]"
fi

# --- CG40: zsh で起動しても reason の report-status.sh が実在する ---
if command -v zsh >/dev/null 2>&1; then
  d=$(mkdir_case cg40)
  set_status "$d" executing
  : > "$d/.assigned-task-exec"
  out=$(cd "$TMP" && DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=exec \
    DISPATCH_GATE_AGENT=task-exec zsh "$BIN" --gate-id cmux-team-dispatch-task 2>/dev/null)
  reason=$(jq -r '.reason // empty' <<< "$out" 2>/dev/null)
  rs=$(sed -n 's/.*bash \([^ ]*report-status\.sh\).*/\1/p' <<< "$reason")
  if [[ -n "$rs" && -f "$rs" ]]; then
    pass 'CG40: zsh 起動でも reason の report-status.sh が実在する'
  else
    bad "CG40: 解決されたパスが実在しない: [$rs]"
  fi
else
  pass 'CG40: zsh が無いので skip'
fi

# --- CG41: 新しい point の request 待ちを allow する ---
d=$(mkdir_case cg41)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'findings\nVERDICT: approve\n' > "$d/review/spec-round-1.md"
sleep 1
printf 'request\n' > "$d/review/plan-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG41: 新しい point の request 待ちを allow する' \
  || bad "CG41: block された: [$out]"

# --- CG42: 古い未応答 request は、新しい他 point の findings に負けない ---
d=$(mkdir_case cg42)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/plan-round-1.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG42: 古い未応答 request の待機を allow する' \
  || bad "CG42: 待機なのに block された: [$out]"

# --- CG43: 待機を allow するとき lease を書く ---
d=$(mkdir_case cg43)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
if [[ -z "$out" ]] && jq -e '.generation == "spec|1|design|task-design" and (.lease_seq | type) == "number" and (.deadline_epoch | type) == "number"' \
  "$d/.gate-wait-design" >/dev/null 2>&1; then
  pass 'CG43: 待機の allow で lease を書く'
else
  bad "CG43: lease が無いか形が違う: [$(cat "$d/.gate-wait-design" 2>/dev/null)]"
fi

# --- CG44: lease_seq は lease を消して作り直しても再利用されない ---
d=$(mkdir_case cg44)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
bash "$BIN" --status-dir "$d" --role design --agent task-design >/dev/null 2>&1
s1=$(jq -r '.lease_seq' "$d/.gate-wait-design")
rm -f "$d/.gate-wait-design"
# rapid restart では lease を再武装しない。別の wake で再び待機に入った条件を作る。
echo $(( $(date +%s) - 600 )) > "$d/.gate-seen-design"
bash "$BIN" --status-dir "$d" --role design --agent task-design >/dev/null 2>&1
s2=$(jq -r '.lease_seq' "$d/.gate-wait-design")
[[ "$s1" != "$s2" ]] && pass 'CG44: 削除→再作成でも lease_seq が再利用されない' \
  || bad "CG44: lease_seq が再利用された: s1=$s1 s2=$s2"

# --- CG45: WAIT_MINUTES=0 では lease を arm せず、既存 lease を消す ---
d=$(mkdir_case cg45)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
printf '{"generation":"x","lease_seq":1,"deadline_epoch":1}\n' > "$d/.gate-wait-design"
out=$(DISPATCH_GATE_WAIT_MINUTES=0 bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
if [[ -z "$out" && ! -f "$d/.gate-wait-design" ]]; then
  pass 'CG45: WAIT_MINUTES=0 では lease を arm せず既存 lease を消す'
else
  bad "CG45: out=[$out] lease=[$(cat "$d/.gate-wait-design" 2>/dev/null)]"
fi

# --- CG46–CG52: design の委譲記録と評価順 ---
d=$(mkdir_case cg46); set_status "$d" executing; : > "$d/.assigned-task-design"; : > "$d/.deferred"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
jq -e '.reason | test("phase-b-deliver.sh")' >/dev/null 2>&1 <<< "$out" \
  && pass 'CG46: marker 無しの .deferred を block する' \
  || bad "CG46: block されないか reason が誘導しない: [$out]"

d=$(mkdir_case cg47); set_status "$d" executing; : > "$d/.assigned-task-design"; : > "$d/.deferred"; : > "$d/.assigned-task"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -n "$out" ]] && pass 'CG47: 似た名前の marker では通さない' \
  || bad 'CG47: 前方一致で通ってしまった'

d=$(mkdir_case cg48); set_status "$d" executing; : > "$d/.assigned-task-design"; : > "$d/.assigned-task-exec"; : > "$d/.deferred"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG48: .deferred と exact marker の両方で allow' \
  || bad "CG48: block された: [$out]"

d=$(mkdir_case cg49); set_status "$d" done; : > "$d/.assigned-task-design"; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -n "$out" ]] && pass 'CG49: half-transition の done を block する' \
  || bad 'CG49: 送信失敗を完了扱いした'

d=$(mkdir_case cg50); set_status "$d" error; : > "$d/.assigned-task-design"; printf 'not json' > "$d/prewarm.json"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG50: error は prewarm 破損でも allow する' \
  || bad "CG50: 失敗したペインを閉じ込めた: [$out]"

d=$(mkdir_case cg51); set_status "$d" executing; : > "$d/.assigned-task-design"; : > "$d/.deferred"; rm -f "$d/prewarm.json"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -n "$out" ]] && pass 'CG51: prewarm 欠落で fail-closed' \
  || bad 'CG51: snapshot が無いのに通した'

d=$(mkdir_case cg51b); set_status "$d" executing; : > "$d/.assigned-task-design"; : > "$d/.escalated"; rm -f "$d/prewarm.json"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG51b: escalation は prewarm 欠落より先に allow' \
  || bad "CG51b: parent 判断待ちを閉じ込めた: [$out]"

d=$(mkdir_case cg52); set_status "$d" executing
jq -n '{reviewer_agent:"task-exec-review"}' > "$d/review/code-review.json"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
[[ -z "$out" ]] && pass 'CG52: 割り当て前の standby exec を止めない' \
  || bad "CG52: standby を block した: [$out]"

# --- CG53–CG55: identity 欠落時の fail-open 痕跡 ---
d=$(mkdir_case cg53); mkdir -p "$TMP/wt53"
jq -n --arg s "$d" '{status_dir:$s}' > "$TMP/wt53/.dispatch-handoff.json"
out=$(cd "$TMP/wt53" && env -u DISPATCH_GATE_STATUS_DIR -u DISPATCH_GATE_ROLE \
  -u DISPATCH_GATE_AGENT bash "$BIN" --gate-id cmux-team-dispatch-task 2>/dev/null)
rc=$?
if [[ $rc -eq 0 && -z "$out" ]] && jq -e '(.count | type) == "number"' "$d/.gate-open" >/dev/null 2>&1; then
  pass 'CG53: fail-open の痕跡を status dir に残す'
else
  bad "CG53: rc=$rc out=[$out] gate-open=[$(cat "$d/.gate-open" 2>/dev/null)]"
fi

(cd "$TMP/wt53" && env -u DISPATCH_GATE_STATUS_DIR -u DISPATCH_GATE_ROLE \
  -u DISPATCH_GATE_AGENT bash "$BIN" --gate-id cmux-team-dispatch-task >/dev/null 2>&1)
n=$(jq -r '.count' "$d/.gate-open" 2>/dev/null)
files=$(find "$d" -maxdepth 1 -name '.gate-open*' -type f | wc -l | tr -d ' ')
[[ "$n" == 2 && "$files" == 1 ]] && pass 'CG54: 痕跡は増えず count だけ進む' \
  || bad "CG54: count=$n files=$files"

mkdir -p "$TMP/wt55"
(cd "$TMP/wt55" && env -u DISPATCH_GATE_STATUS_DIR -u DISPATCH_GATE_ROLE \
  -u DISPATCH_GATE_AGENT bash "$BIN" --gate-id cmux-team-dispatch-task >/dev/null 2>&1)
[[ -z "$(find "$TMP/wt55" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
  && pass 'CG55: handoff が無ければ何も書かない' \
  || bad "CG55: 無関係な worktree を汚した: $(find "$TMP/wt55" -mindepth 1 -maxdepth 1 -print)"

# --- CG56: 予算切れの待機は block して回復手順へ誘導する ---
d=$(mkdir_case cg56)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
touch -t "$(date -v-40M +%Y%m%d%H%M 2>/dev/null || date -d '40 minutes ago' +%Y%m%d%H%M)" "$d/review/spec-round-1-request.md"
printf '%s\n' "$(( $(date +%s) - 10 ))" > "$d/.gate-seen-design"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
reason=$(jq -r '.reason // empty' <<< "$out" 2>/dev/null)
if [[ "$reason" == *'spec round 1'* && "$reason" == *"$d/review/spec-round-1-abort.md"* \
  && "$reason" == *'escalate.sh'* && "$reason" != *"touch $d/.escalated"* ]]; then
  pass 'CG56: 予算切れで block し、実値で回復手順を示す'
else
  bad "CG56: reason が回復手順を欠く: [$reason]"
fi

d=$(mkdir_case cg56b)
set_status "$d" executing
: > "$d/.assigned-task-exec"
printf 'request\n' > "$d/review/code-round-1-request.md"
touch -t "$(date -v-40M +%Y%m%d%H%M 2>/dev/null || date -d '40 minutes ago' +%Y%m%d%H%M)" "$d/review/code-round-1-request.md"
printf '%s\n' "$(( $(date +%s) - 10 ))" > "$d/.gate-seen-exec"
jq -n '{reviewer_agent:"task-exec-review", reviewer_engine:"claude"}' > "$d/review/code-review.json"
out=$(DISPATCH_GATE_TEAM=demo-team bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
reason=$(jq -r '.reason // empty' <<< "$out" 2>/dev/null)
if [[ "$reason" == *'claude reviewer task-exec-review'* && "$reason" != *'verify-agmsg-ready.sh --codex'* ]]; then
  pass 'CG56b: claude reviewer に codex seat 確認を指示しない'
else
  bad "CG56b: reviewer engine を取り違えた: [$reason]"
fi

# --- CG57: 予算内かつ rapid restart なしは allow ---
d=$(mkdir_case cg57)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'request\n' > "$d/review/spec-round-1-request.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -z "$out" ]] && pass 'CG57: 素の待機は従来どおり allow' || bad "CG57: block された: [$out]"

# --- CG60: abort + VERDICT 無し findings で依頼側は待機を終える ---
d=$(mkdir_case cg60)
set_status "$d" executing
: > "$d/.assigned-task-design"
printf 'req\n' > "$d/review/spec-round-1-request.md"
printf 'f only\n' > "$d/review/spec-round-1.md"
sleep 1
printf 'a\n' > "$d/review/spec-round-1-abort.md"
out=$(bash "$BIN" --status-dir "$d" --role design --agent task-design 2>/dev/null)
[[ -n "$out" ]] && pass 'CG60: abort 済みなら依頼側は待機しない' \
  || bad 'CG60: abort 済みなのに待機として allow した (tick と逆転する)'
[[ "$(jq -r '.generation // empty' "$d/.gate-wait-design" 2>/dev/null)" == 'progress|design|task-design' ]] \
  && pass 'CG60b: abort 後は進捗 lease へ切り替わる' \
  || bad "CG60b: 進捗 lease へ切り替わらない: [$(cat "$d/.gate-wait-design" 2>/dev/null)]"

# --- CG61: レビュアー側は従来どおり abort で allow する ---
d=$(mkdir_case cg61)
set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"
printf 'f only\n' > "$d/review/spec-round-1.md"
sleep 1
printf 'a\n' > "$d/review/spec-round-1-abort.md"
out=$(bash "$BIN" --status-dir "$d" --role design_review --agent task-review 2>/dev/null)
[[ -z "$out" ]] && pass 'CG61: レビュアー側は abort で allow (従来どおり)' \
  || bad "CG61: レビュアが block された: [$out]"

# --- CG62–CG64: 判定 7 の進捗 lease ---
d=$(mkdir_case cg62); set_status "$d" executing; : > "$d/.assigned-task-exec"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null)
if [[ -n "$out" ]] && jq -e '.generation == "progress|exec|task-exec"' "$d/.gate-wait-exec" >/dev/null 2>&1; then
  pass 'CG62: 判定 7 で進捗 lease を張る'
else
  bad "CG62: lease=[$(cat "$d/.gate-wait-exec" 2>/dev/null)]"
fi
d1=$(jq -r '.deadline_epoch' "$d/.gate-wait-exec"); sleep 1
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
d2=$(jq -r '.deadline_epoch' "$d/.gate-wait-exec")
[[ "$d2" -gt "$d1" ]] && pass 'CG63: 判定 7 のたびに deadline が延びる' || bad "CG63: $d1 -> $d2"
d=$(mkdir_case cg64); set_status "$d" executing; : > "$d/.assigned-task-exec"
printf 'req\n' > "$d/review/code-round-1-request.md"
bash "$BIN" --status-dir "$d" --role exec --agent task-exec >/dev/null 2>&1
gen=$(jq -r '.generation' "$d/.gate-wait-exec")
[[ "$gen" == 'code|1|exec|task-exec' ]] && pass 'CG64: 待機中は待機 lease が優先される' || bad "CG64: generation=[$gen]"

# CG-P1: exec が code のレビュー待ちである間、design 側の新しい VERDICT に隠されない。
# 2026-09-02 の F1 の再現: reviewer は code-round-1.md を書き始めているが VERDICT はまだ無く、
# design-round-2.md (VERDICT 付き) の方が新しい。スコープ前はここで判定 7 に落ち、
# 実装者に error を勧めていた。
d=$(mkdir_case cgp1); set_status "$d" executing
: > "$d/.assigned-task-exec"
printf 'req\n' > "$d/review/code-round-1-request.md"; sleep 1
printf 'partial findings\n' > "$d/review/code-round-1.md"; sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/design-round-2.md"
out=$(bash "$BIN" --status-dir "$d" --role exec --agent task-exec 2>/dev/null); rc=$?
if [[ $rc -eq 0 && -z "$out" ]]; then
  pass "CG-P1: code へスコープした exec は待機として allow される"
else
  bad "CG-P1: rc=$rc out=[$out]"
fi

# CG-P2: design ロールは code point のファイルで待機しない。
#        code のレビューは exec の仕事であり、design がそれを自分の待機と読むと
#        委譲後の設計ペインが exec のレビュー中ずっと停止できてしまう。
d=$(mkdir_case cgp2); set_status "$d" executing
: > "$d/.assigned-task"
printf 'findings\n' > "$d/review/code-round-1.md"
out=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=task \
  bash "$BIN" 2>/dev/null)
grep -q '"decision":"block"' <<<"$out" \
  && pass 'CG-P2: design は code point の findings で待機しない' \
  || bad "CG-P2: out=[$out]"

# CG-P3: 逆向き。design が自分の point で待機しているとき、より新しい code の
#        VERDICT 付き findings に隠されない (F1 の design 側)。
d=$(mkdir_case cgp3); set_status "$d" executing
: > "$d/.assigned-task"
printf 'req\n' > "$d/review/plan-round-1-request.md"; sleep 1
printf 'findings\nVERDICT: approve\n' > "$d/review/code-round-1.md"
out=$(DISPATCH_GATE_STATUS_DIR="$d" DISPATCH_GATE_ROLE=design DISPATCH_GATE_AGENT=task \
  bash "$BIN" 2>/dev/null); rc=$?
[[ $rc -eq 0 && -z "$out" ]] \
  && pass 'CG-P3: design の待機は新しい code の VERDICT に隠されない' \
  || bad "CG-P3: rc=$rc out=[$out]"

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
