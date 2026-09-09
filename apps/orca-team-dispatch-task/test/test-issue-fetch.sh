#!/usr/bin/env bash
# issue の claim / lock / state。**claim したのに記録できていない状態を作らない**ことが全部である。
# 移植元は cmux 版。変えた 4 点（IF6 が見る痕跡がその 1 つ）以外は失敗様式ごと持ち込んでいる。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
IF="$P/skills/orca-team-dispatch-task/scripts/issue-fetch.sh"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  W=$(mktemp -d); LD="$W/.dispatch-issue"; mkdir -p "$LD"
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
  rm -rf "$W"; unset GH_STUB_DIR LOOP_SESSION_ID DISPATCH_DIR LOOP_REPO_ROOT
}
run() { bash "$IF" --state-file "$SF" "$@"; }
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
  && grep -q -- '--remove-label dispatch/in-progress' "$GH_STUB_DIR/calls.log" \
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
  && grep -q -- '--remove-label dispatch/in-progress' "$GH_STUB_DIR/calls.log" \
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

# IF9: ensure-labels は 3 ラベルを冪等に作る。既にあるものは作り直さない。
setup; acquire
jq -nc '[{name:"dispatch/in-progress"}]' > "$GH_STUB_DIR/label_list"
: > "$GH_STUB_DIR/label_create"
run ensure-labels >/dev/null 2>&1; rc=$?
created=$(grep -c 'label create' "$GH_STUB_DIR/calls.log")
[[ "$rc" -eq 0 && "$created" -eq 2 ]] \
  && grep -q 'orca-team-dispatch-task' "$GH_STUB_DIR/calls.log" \
  && ok "IF9 足りないラベルだけ作る" || fail "IF9 (rc=$rc created=$created)"
teardown

# IF10: owner 以外は state を書けない（lock を持たない者の書き込みを拒む）。
setup; acquire; init
LOOP_SESSION_ID=other-session run mark-dispatched --issue 1 >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "IF10 owner 以外は state を書けない" || fail "IF10"
teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
