#!/usr/bin/env bash
# issue の claim / lock / state。**claim したのに記録できていない状態を作らない**ことが全部である。
# 移植元は cmux 版。変えた点（IF6 が見る痕跡も含む）以外は失敗様式ごと持ち込んでいる。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
IF="$P/skills/orca-team-dispatch-task/scripts/issue-fetch.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  W=$(mktemp -d); export ORCA_DISPATCH_CONFIG_HOME="$W/config"; LD="$W/.dispatch-issue"; mkdir -p "$LD"
  SF="$LD/state.json"
  GH_STUB_DIR="$W/gh"; mkdir -p "$GH_STUB_DIR"; : > "$GH_STUB_DIR/calls.log"
  BIN="$W/bin"; mkdir -p "$BIN"
  { echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/gh-stub.sh"; } > "$BIN/gh"
  chmod +x "$BIN/gh"
  export GH_STUB_DIR PATH="$BIN:$PATH" LOOP_SESSION_ID=sess-test
  export DISPATCH_DIR="$W/.dispatch" LOOP_REPO_ROOT="$W"
  mkdir -p "$DISPATCH_DIR"
  OLDPATH_SAVED=1
}
teardown() {
  PATH="${PATH#"$BIN":}"; export PATH
  rm -rf "$W"; unset GH_STUB_DIR LOOP_SESSION_ID DISPATCH_DIR LOOP_REPO_ROOT ORCA_DISPATCH_CONFIG_HOME
}
run() { node "$IF" --state-file "$SF" "$@"; }
acquire() { run lock-acquire --lease-min 30 >/dev/null 2>&1; }
init() { run init --config-json '{"concurrency":2}' --filter-json '{"state":"open"}' >/dev/null 2>&1; }

# IF1: ★ **lock は所有者が生きている間、他を通さない。**通すと 2 つのループが同じ issue を
#      claim して、同じ worktree 名で衝突する。
setup
run lock-check >/dev/null 2>&1; [[ $? -eq 0 ]] || fail "IF1 未取得で lock-check が落ちた"
acquire
run lock-check >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "IF1 生きている lock は lock-check を通さない" || fail "IF1"
teardown

# IF2: ★ **owner.json の欠落・破損を「lock 無し」と読まない。**取得の途中で覗かれると
#      owner.json がまだ無い瞬間がある。有限の grace の間は in-flight として守る。
setup; acquire
printf 'not json\n' > "$LD/loop.lock.d/owner.json"
run lock-check >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "IF2 壊れた owner.json も grace の間は守る" || fail "IF2"
teardown

# IF3: lease が切れていれば奪える（無限に固まらない）。
setup; acquire
jq '.heartbeat = "2000-01-01T00:00:00Z"' "$LD/loop.lock.d/owner.json" > "$LD/o" && mv "$LD/o" "$LD/loop.lock.d/owner.json"
run lock-check >/dev/null 2>&1
[[ $? -eq 0 ]] && ok "IF3 lease 切れの lock は奪える" || fail "IF3"
teardown

# IF4: ★ **claim に失敗した issue を tasks に混ぜない。**混ぜると dispatch 先の無い
#      issue を走らせることになる。
setup; acquire; init
jq -nc '[{number:1,title:"first",body:"b",url:"u1",labels:[]},
         {number:2,title:"second",body:"b",url:"u2",labels:[]}]' > "$GH_STUB_DIR/issue_list"
printf '%s\n' '#!/usr/bin/env bash' > /dev/null
# issue 1 の claim だけ失敗させる
cat > "$GH_STUB_DIR/issue_edit" <<'EOF'
EOF
printf '1\n' > "$GH_STUB_DIR/issue_edit.rc"
out=$(run fetch --limit 2 --batch 1 2>/dev/null); rc=$?
[[ "$rc" -eq 3 ]] && ok "IF4 claim が 1 件も成立しなければ exit 3" || fail "IF4 (rc=$rc out=$out)"
teardown

# IF5: ★ **state 記録に失敗したら claim を取り消す。**取り消さないと、誰も dispatch
#      しない issue に `dispatch/in-progress` が残り続ける。
setup; acquire; init
jq -nc '[{number:7,title:"only",body:"b",url:"u7",labels:[]}]' > "$GH_STUB_DIR/issue_list"
: > "$GH_STUB_DIR/issue_edit"
chmod 500 "$LD"   # state を書けなくする
out=$(run fetch --limit 1 --batch 1 2>&1); rc=$?
chmod 700 "$LD"
[[ "$rc" -ne 0 ]] \
  && grep -qF -- '--remove-label In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF5 state を書けなければ claim を取り消す" || fail "IF5 (rc=$rc)"
teardown

# IF6: ★ **痕跡の判定が Orca の形になっている**（移植で変えた 4 点のうちの 2 つ）。
#      cmux 版は `prewarm.json` と `<repo>/.worktrees/<slug>` を見ていた。Orca の
#      worktree は repo の外に作られるので、`workers.json` の `worktree_path` を見る。
setup; acquire; init
run finalize --issue 9 --status claimed >/dev/null 2>&1
jq '.issues["9"] = {slug:"issue-9-x",status:"claimed"}' "$SF" > "$LD/s" && mv "$LD/s" "$SF"
mkdir -p "$DISPATCH_DIR/issue-9-x"
WTP="$W/outside-the-repo/issue-9-x"; mkdir -p "$WTP"
jq -nc --arg p "$WTP" '{roles:{design:{worktree_path:$p}}}' > "$DISPATCH_DIR/issue-9-x/workers.json"
out=$(run reconcile 2>/dev/null)
[[ "$(jq -r '.action' <<<"$out")" == abort ]] \
  && [[ "$(jq -r '.reasons | join(" ")' <<<"$out")" == *workers.json* ]] \
  && [[ "$(jq -r '.reasons | join(" ")' <<<"$out")" == *worktree* ]] \
  && ok "IF6 痕跡は workers.json と worktree_path の実在で見る" || fail "IF6 ($out)"
teardown

# IF7: 痕跡が無ければ release して state から消す（claim を握ったまま死なない）。
setup; acquire; init
jq '.issues["11"] = {slug:"issue-11-y",status:"claimed"}' "$SF" > "$LD/s" && mv "$LD/s" "$SF"
: > "$GH_STUB_DIR/issue_edit"
out=$(run reconcile 2>/dev/null)
[[ "$(jq -r '.action' <<<"$out")" == ok ]] \
  && [[ "$(jq -r '.issues | length' "$SF")" -eq 0 ]] \
  && grep -qF -- '--remove-label In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF7 痕跡が無ければ release して state から消す" || fail "IF7 ($out)"
teardown

# IF8: ★ **dispatched のまま残る issue があれば abort。**その worker は生きているかも
#      しれない。新しいループを重ねてはならない。
setup; acquire; init
jq '.issues["13"] = {slug:"issue-13-z",status:"dispatched"}' "$SF" > "$LD/s" && mv "$LD/s" "$SF"
out=$(run reconcile 2>/dev/null)
[[ "$(jq -r '.action' <<<"$out")" == abort ]] \
  && ok "IF8 dispatched が残っていれば abort" || fail "IF8 ($out)"
teardown

# IF9: ensure-labels はステータスラベルを全部、冪等に作る。既にあるものは作り直さない。
setup; acquire
jq -nc '[{name:"In progress"}]' > "$GH_STUB_DIR/label_list"
: > "$GH_STUB_DIR/label_create"
run ensure-labels >/dev/null 2>&1; rc=$?
created=$(grep -c 'label create' "$GH_STUB_DIR/calls.log")
[[ "$rc" -eq 0 && "$created" -eq 8 ]] \
  && ! grep -qF 'label create In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF9 足りないラベルだけ作る" || fail "IF9 (rc=$rc created=$created)"
teardown

# IF10: owner 以外は state を書けない（lock を持たない者の書き込みを拒む）。
setup; acquire; init
LOOP_SESSION_ID=other-session run mark-dispatched --issue 1 >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "IF10 owner 以外は state を書けない" || fail "IF10"
teardown

# IF11: ★ **単件指定は検索を通さない。**ラベルや assignee で絞る意味が無いうえ、
#       検索から漏れた issue を指定できなくなる。
setup; acquire; init
jq -nc '{number:21,title:"one only",body:"b",url:"u21",labels:[]}' > "$GH_STUB_DIR/issue_view"
: > "$GH_STUB_DIR/issue_edit"
out=$(run fetch --issue 21 --limit 5 --batch 1 2>/dev/null); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(jq -r '.[0].number' <<<"$out")" == 21 ]] \
  && [[ "$(jq -r '.[0].slug' <<<"$out")" == issue-21-* ]] \
  && ! grep -q 'issue list' "$GH_STUB_DIR/calls.log" \
  && grep -qF -- '--add-label In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF11 単件は検索せずに claim する" || fail "IF11 (rc=$rc out=$out)"
teardown

# IF12: 単件でも **claim の補償は共通経路**を通る。state を書けなければラベルを戻す。
setup; acquire; init
jq -nc '{number:22,title:"one only",body:"b",url:"u22",labels:[]}' > "$GH_STUB_DIR/issue_view"
: > "$GH_STUB_DIR/issue_edit"
chmod 500 "$LD"
run fetch --issue 22 --limit 1 --batch 1 >/dev/null 2>&1; rc=$?
chmod 700 "$LD"
[[ "$rc" -ne 0 ]] \
  && grep -qF -- '--remove-label In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF12 単件でも claim の補償が働く" || fail "IF12 (rc=$rc)"
teardown

# IF13: 既に state に載っている issue を単件指定したら **claim し直さない**。
setup; acquire; init
jq '.issues["23"] = {slug:"issue-23-x",status:"done"}' "$SF" > "$LD/s" && mv "$LD/s" "$SF"
jq -nc '{number:23,title:"already",body:"b",url:"u23",labels:[]}' > "$GH_STUB_DIR/issue_view"
: > "$GH_STUB_DIR/issue_edit"
out=$(run fetch --issue 23 --limit 1 --batch 1 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == '[]' ]] \
  && ! grep -qF -- '--add-label In\ progress' "$GH_STUB_DIR/calls.log" \
  && ok "IF13 state に載っている issue は claim し直さない" || fail "IF13 (rc=$rc out=$out)"
teardown

# IF14: zsh から呼んでも同じ結果になる（設計 3-5。SKILL.md の I0〜I4 は呼び出し側のシェルで走る）
if command -v zsh >/dev/null 2>&1; then
  setup; acquire
  zsh -c 'node "$1" --state-file "$2" lock-check' zsh "$IF" "$SF" >/dev/null 2>&1; z=$?
  bash -c 'node "$1" --state-file "$2" lock-check' bash "$IF" "$SF" >/dev/null 2>&1; b=$?
  [[ "$z" -eq 1 && "$b" -eq 1 ]] && ok "IF14 zsh から呼んでも同じ結果" || fail "IF14 ($z/$b)"
  teardown
else
  echo "SKIP: IF14 zsh が無い"
fi
# IF15: 数字でない lease は生きた lock を期限切れと誤認するので受け付けない。
setup; acquire
out=$(run lock-check --lease-min abc 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'--lease-min requires a number'* ]] \
  && ok "IF15 不正な lease を拒否" || fail "IF15 (rc=$rc out=$out)"
teardown

# IF16: 読めない既存の state は新規 state で上書きしない。
setup; acquire; printf 'broken\n' > "$SF"
out=$(run init --config-json '{}' --filter-json '{}' 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'failed to update state'* && "$(cat "$SF")" == broken ]] \
  && ok "IF16 壊れた state を上書きしない" || fail "IF16 (rc=$rc out=$out)"
teardown
# IF17: ★ **大文字小文字だけ違うラベルを作り直さない。**GitHub のラベル名は大文字小文字を区別しないので、
#       `ready` があるリポジトリで `Ready` を作ろうとすると失敗し、claim まで進めなくなる。
setup; acquire
jq -nc '[{name:"ready"},{name:"done"}]' > "$GH_STUB_DIR/label_list"
: > "$GH_STUB_DIR/label_create"
run ensure-labels >/dev/null 2>&1; rc=$?
created=$(grep -c 'label create' "$GH_STUB_DIR/calls.log")
[[ "$rc" -eq 0 && "$created" -eq 7 ]] \
  && ! grep -qE 'label create (Ready|Done) ' "$GH_STUB_DIR/calls.log" \
  && grep -qF -- '--color' "$GH_STUB_DIR/calls.log" \
  && grep -qF -- '--description' "$GH_STUB_DIR/calls.log" \
  && ok "IF17 大文字小文字だけ違うラベルは作り直さず、色と説明を付けて作る" || fail "IF17 (rc=$rc created=$created)"
teardown

# IF18: ★ **検索はステータスラベル 7 つと古い dispatch の 3 つを除外する。**古いラベルを外すと、
#       3.10 までに done / failed になった issue をもう一度拾う。Ready は人が「やる」と決めた印なので除外しない。
setup; acquire; init
jq -nc '[]' > "$GH_STUB_DIR/issue_list"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "$GH_STUB_DIR/issue_list.args"\n' > "$GH_STUB_DIR/issue_list.hook"
chmod +x "$GH_STUB_DIR/issue_list.hook"
run fetch --limit 1 --batch 1 >/dev/null 2>&1
search=$(grep -A1 -x -- '--search' "$GH_STUB_DIR/issue_list.args" | tail -1)
[[ "$search" == *'-label:"In progress"'* && "$search" == *'-label:"Backlog"'* \
   && "$search" == *'-label:"dispatch/done"'* && "$search" != *'-label:"Ready"'* ]] \
  && ok "IF18 検索はステータスラベルと古い dispatch を除外し、Ready は除外しない" || fail "IF18 ($search)"
teardown

# IF19: ★ **claim は issue に付いたステータスラベルを外して In progress にし、claim を戻すときは元に戻す。**
#       1 つの issue にステータスラベルは 1 つ。戻さないと、人が「やる」と決めた印が消えたままになる。
setup; acquire; init
jq -nc '[{number:31,title:"ready one",body:"b",url:"u31",labels:[{name:"ready"}]}]' > "$GH_STUB_DIR/issue_list"
: > "$GH_STUB_DIR/issue_edit"
chmod 500 "$LD"
run fetch --limit 1 --batch 1 >/dev/null 2>&1
chmod 700 "$LD"
undo_ok=0
grep -qF -- 'issue edit 31 --add-label In\ progress --remove-label ready' "$GH_STUB_DIR/calls.log" \
  && grep -qF -- 'issue edit 31 --remove-label In\ progress --add-label ready' "$GH_STUB_DIR/calls.log" && undo_ok=1
: > "$GH_STUB_DIR/calls.log"
out=$(run fetch --limit 1 --batch 1 2>/dev/null)
recorded=$(jq -c '.issues["31"].restore' "$SF")
: > "$GH_STUB_DIR/calls.log"
run release --issue 31 >/dev/null 2>&1
[[ "$undo_ok" -eq 1 && "$recorded" == '["ready"]' ]] \
  && grep -qF -- 'issue edit 31 --remove-label In\ progress --add-label ready' "$GH_STUB_DIR/calls.log" \
  && ok "IF19 claim で Ready を外し、取り消しと release で戻す" || fail "IF19 (undo=$undo_ok restore=$recorded $out)"
teardown

# IF20: ★ **名指しの issue は、どのステータスラベルが付いていても In progress だけにする。**slack-issue-intake が
#       起票した issue には Backlog が付いている。残すと終わったあとも Backlog と Done が並ぶ。
setup; acquire; init
jq -nc '{number:32,title:"named",body:"b",url:"u32",labels:[{name:"Backlog"},{name:"bug"}]}' > "$GH_STUB_DIR/issue_view"
: > "$GH_STUB_DIR/issue_edit"
run fetch --issue 32 --limit 1 --batch 1 >/dev/null 2>&1
restore=$(jq -c '.issues["32"].restore' "$SF")
[[ "$restore" == '["Backlog"]' ]] \
  && grep -qF -- 'issue edit 32 --add-label In\ progress --remove-label Backlog' "$GH_STUB_DIR/calls.log" \
  && ! grep -qF -- '--remove-label bug' "$GH_STUB_DIR/calls.log" \
  && ok "IF20 名指しの issue のステータスラベルを In progress に置き換えて記録する" || fail "IF20 (restore=$restore)"
teardown

# IF21: ★ **claim を戻すときは古い dispatch のラベルも外す。**3.10 で claim した issue を 3.11 で release すると、
#       dispatch/in-progress が残り、検索から永久に外れたうえ state からも消えて痕跡が無くなる。
#       reconcile は記録した restore も戻す。
setup; acquire; init
jq '.issues["33"] = {slug:"issue-33-old",status:"claimed"} | .issues["34"] = {slug:"issue-34-r",status:"claimed",restore:["Ready"]}' \
  "$SF" > "$LD/s" && mv "$LD/s" "$SF"
: > "$GH_STUB_DIR/issue_edit"
out=$(run reconcile 2>/dev/null)
[[ "$(jq -r '.action' <<<"$out")" == ok ]] \
  && grep -qF -- 'issue edit 33 --remove-label dispatch/in-progress' "$GH_STUB_DIR/calls.log" \
  && grep -qF -- 'issue edit 34 --remove-label In\ progress --add-label Ready' "$GH_STUB_DIR/calls.log" \
  && ok "IF21 claim を戻すときは古いラベルも外し、記録したラベルを戻す" || fail "IF21 ($out)"
teardown
for repo in ACME/APP other/api; do
  setup; acquire; init
  mkdir -p "$ORCA_DISPATCH_CONFIG_HOME/auto/main"
  printf '%s' '{"version":1,"sources":[{"repo":"acme/app"}]}' > "$ORCA_DISPATCH_CONFIG_HOME/auto/main/config.json"
  printf '{"nameWithOwner":"%s"}' "$repo" > "$GH_STUB_DIR/repo_view"
  echo '[]' > "$GH_STUB_DIR/issue_list"
  cat > "$GH_STUB_DIR/issue_list.hook" <<'HOOK'
#!/bin/sh
printf '%s\n' "$@" > "$GH_STUB_DIR/issue_list.args"
HOOK
  chmod +x "$GH_STUB_DIR/issue_list.hook"
  run fetch --limit 1 --batch 1 --dry-run >/dev/null 2>&1
  search=$(grep -A1 -x -- '--search' "$GH_STUB_DIR/issue_list.args" | tail -1)
  if [[ "$repo" == ACME/APP ]]; then
    [[ "$search" == *'-label:"Ready"'* ]] && ok IF22 || fail "IF22 ($search)"
  else
    [[ "$search" != *'-label:"Ready"'* ]] && ok IF23 || fail "IF23 ($search)"
  fi
  teardown
done
# IF24: ★ **向き先のラベルが今のブランチと違う Issue は claim しない。**claim すると、別のブランチ向けの作業を
#       今のブランチへ取り込んでしまう。飛ばした Issue は claim の試行に数えない（数えると全部飛ばした run が rc 3 になる）。
setup; acquire; init
git -C "$W" init -q -b develop
jq -nc '[{number:1,title:"to main",body:"b",url:"u1",labels:[{name:"base:main"}]},
         {number:2,title:"to develop",body:"b",url:"u2",labels:[{name:"base:develop"}]},
         {number:3,title:"unlabeled",body:"b",url:"u3",labels:[{name:"bug"}]}]' > "$GH_STUB_DIR/issue_list"
out=$(run fetch --limit 5 --batch 1 2>"$W/err"); rc=$?
claimed=$(jq -c '[.[].number]' <<<"$out" 2>/dev/null)
[[ "$rc" -eq 0 && "$claimed" == '[2,3]' ]] \
  && grep -qF '[skip] issue #1 は向き先が main なので、今のブランチ develop では扱いません' "$W/err" \
  && ! grep -qF 'issue edit 1 ' "$GH_STUB_DIR/calls.log" \
  && ok "IF24 向き先の違う Issue は claim せず [skip] を出し、一致とラベル無しは claim する" || fail "IF24 (rc=$rc claimed=$claimed $(cat "$W/err"))"
# 全部飛ばしても claim の失敗ではない（rc 3 にしない）
: > "$GH_STUB_DIR/calls.log"
jq -nc '[{number:4,title:"to main",body:"b",url:"u4",labels:[{name:"base:main"}]}]' > "$GH_STUB_DIR/issue_list"
out=$(run fetch --limit 5 --batch 2 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == '[]' ]] && ok "IF24 全部飛ばしたら空で rc 0（claim 失敗の rc 3 にしない）" || fail "IF24 (rc=$rc out=$out)"
teardown

# IF25: ★ **向きのラベルが 2 つ以上の Issue は claim しない**（どちらへ取り込むか決められない）。
#       detached HEAD では、ラベルの無い Issue だけ今までどおり扱い、ラベルが付いた Issue は全部飛ばす。
setup; acquire; init
git -C "$W" init -q -b develop
jq -nc '[{number:5,title:"both",body:"b",url:"u5",labels:[{name:"base:main"},{name:"base:develop"}]}]' > "$GH_STUB_DIR/issue_list"
out=$(run fetch --limit 5 --batch 1 2>"$W/err"); rc=$?
[[ "$rc" -eq 0 && "$out" == '[]' ]] \
  && grep -qF '[skip] issue #5 ' "$W/err" && ! grep -qF 'issue edit 5 ' "$GH_STUB_DIR/calls.log" \
  && ok "IF25 base ラベルが 2 つの Issue は claim しない" || fail "IF25 (rc=$rc out=$out $(cat "$W/err"))"
git -C "$W" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$W" checkout -q --detach
: > "$GH_STUB_DIR/calls.log"
jq -nc '[{number:6,title:"to develop",body:"b",url:"u6",labels:[{name:"base:develop"}]},
         {number:7,title:"unlabeled",body:"b",url:"u7",labels:[]}]' > "$GH_STUB_DIR/issue_list"
out=$(run fetch --limit 5 --batch 2 2>"$W/err"); rc=$?
[[ "$rc" -eq 0 && "$(jq -c '[.[].number]' <<<"$out")" == '[7]' ]] \
  && grep -qF '[skip] issue #6 ' "$W/err" && grep -qF 'detached' "$W/err" \
  && ok "IF25 detached HEAD ではラベルの無い Issue だけ扱う" || fail "IF25 detached (rc=$rc out=$out $(cat "$W/err"))"
teardown
# IF26: ★ **名指し（--issue N）でも、向き先のラベルが今のブランチと違う Issue は claim しない。**
#       検索を通らない単件の経路にも同じ判定が効くこと。[skip] で理由を言い、空で rc 0、ラベルには触らない。
setup; acquire; init
git -C "$W" init -q -b develop
jq -nc '{number:41,title:"hotfix",body:"b",url:"u41",labels:[{name:"base:main"}]}' > "$GH_STUB_DIR/issue_view"
: > "$GH_STUB_DIR/issue_edit"
out=$(run fetch --issue 41 --limit 1 --batch 1 2>"$W/err"); rc=$?
[[ "$rc" -eq 0 && "$out" == '[]' ]] \
  && grep -qF '[skip] issue #41 は向き先が main なので、今のブランチ develop では扱いません' "$W/err" \
  && ! grep -qF 'issue edit' "$GH_STUB_DIR/calls.log" \
  && [[ "$(jq -r '.issues["41"] // "none"' "$SF")" == none ]] \
  && ok "IF26 名指しの Issue も向き先が違えば claim しない" || fail "IF26 (rc=$rc out=$out $(cat "$W/err"))"
teardown
echo "failures: $fails"; [[ "$fails" -eq 0 ]]
