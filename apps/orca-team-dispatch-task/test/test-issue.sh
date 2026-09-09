#!/usr/bin/env bash
# issue 1 件を最後まで運ぶ経路。**merge が通って初めて片付けの話になる**ことと、
# **失敗したら資源を残す**ことが全部である。
set -uo pipefail
# テストを走らせる機械の WSL 状態に依存させない（test-start.sh と同じ理由）
unset ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"
  export ORCA_TERMINAL_HANDLE=term_p
  export ORCA_DISPATCH_CONFIG_HOME="$ORCA_STUB_DIR/config"
  GH_STUB_DIR="$ORCA_STUB_DIR/gh"; mkdir -p "$GH_STUB_DIR"; : > "$GH_STUB_DIR/calls.log"
  BIN="$ORCA_STUB_DIR/bin"; mkdir -p "$BIN"
  { echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/gh-stub.sh"; } > "$BIN/gh"
  chmod +x "$BIN/gh"; export GH_STUB_DIR; OLD_PATH="$PATH"; PATH="$BIN:$PATH"; export PATH

  R=$(mktemp -d); git -C "$R" init -q -b main .
  echo seed > "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  WT=$(mktemp -d)/wt; git -C "$R" worktree add -q -b orca/issue-5-x "$WT" >/dev/null 2>&1
  # worker の成果を worktree 側に commit しておく（merge が実際に動くように）
  echo work > "$WT/WORK.md"; git -C "$WT" add -A
  git -C "$WT" -c user.email=t@e -c user.name=t commit -q -m work
  REQ=$(mktemp); echo "fix issue 5" > "$REQ"

  LD="$R/.dispatch-issue"; mkdir -p "$LD"; SF="$LD/state.json"
  export LOOP_SESSION_ID=sess-issue DISPATCH_DIR="$R/.dispatch" LOOP_REPO_ROOT="$R"
  bash "$P/skills/orca-team-dispatch-task/scripts/issue-fetch.sh" --state-file "$SF" \
    lock-acquire --lease-min 30 >/dev/null 2>&1
  bash "$P/skills/orca-team-dispatch-task/scripts/issue-fetch.sh" --state-file "$SF" \
    init --config-json '{}' --filter-json '{}' >/dev/null 2>&1
  jq '.issues["5"] = {slug:"issue-5-x",status:"claimed"}' "$SF" > "$LD/s" && mv "$LD/s" "$SF"

  echo '{"ok":true,"result":{"runtime":{"reachable":true}}}' > "$ORCA_STUB_DIR/status"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_p"}}}' > "$ORCA_STUB_DIR/terminal_show"
  echo '{"ok":true,"result":{"run":{"id":"run_i"}}}' > "$ORCA_STUB_DIR/orchestration_run-create"
  echo '{"ok":true,"result":{"run":{"id":"run_i","coordinator_handle":"term_p"}}}' \
    > "$ORCA_STUB_DIR/orchestration_run-current"
  echo '{"ok":true,"result":{"worktrees":[]}}' > "$ORCA_STUB_DIR/worktree_list"
  printf '{"ok":true,"result":{"worktree":{"id":"wt_i","path":"%s","branch":"refs/heads/orca/issue-5-x"}}}\n' \
    "$WT" > "$ORCA_STUB_DIR/worktree_create"
  echo '{"ok":true,"result":{"task":{"id":"task_i"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_i","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_w"}]}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-start"
  echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
  echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
  echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
  : > "$GH_STUB_DIR/issue_edit"; : > "$GH_STUB_DIR/issue_close"
}
teardown() {
  git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
  PATH="$OLD_PATH"; export PATH
  rm -rf "$ORCA_STUB_DIR" "$R" "$REQ" "$(dirname "$WT")"
  unset ORCA_BIN ORCA_TERMINAL_HANDLE ORCA_DISPATCH_CONFIG_HOME GH_STUB_DIR \
        LOOP_SESSION_ID DISPATCH_DIR LOOP_REPO_ROOT
}
# worker が done を書き、worker_done が 1 件届いた状態にする
worker_done() {   # $1=succeeded|failed  $2=done|error
  cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<HOOK
#!/usr/bin/env bash
mkdir -p "$R/.dispatch/issue-5-x/roles/design"
printf '{"status":"$2"}\n' > "$R/.dispatch/issue-5-x/roles/design/status.json"
printf 'what the worker changed\n' > "$R/.dispatch/issue-5-x/roles/design/result.md"
HOOK
  chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"
  jq -nc --arg o "$1" '{ok:true,result:{runId:"run_i",deliveryId:"di",count:1,messages:[
    {id:"i1",type:"worker_done",payload:({taskId:"task_i",dispatchId:"ctx_i",outcome:$o}|tojson),body:""}]}}' \
    > "$ORCA_STUB_DIR/orchestration_check"
}
run_issue() {
  bash "$P/bin/orca-issue.sh" --state-file "$SF" --issue 5 --slug issue-5-x \
    --request-file "$REQ" --repo-root "$R" --max-waits 1 --timeout-ms 1 "$@"
}
ghlog() { cat "$GH_STUB_DIR/calls.log"; }

# IS1: 成功経路。merge され、ラベルが遷移し、issue が close される。
setup; worker_done succeeded done
out=$(run_issue 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(jq -r '.merged' "$R/.dispatch/issue-5-x/integration-result.json")" == true ]] \
  && git -C "$R" log --oneline | grep -q . \
  && [[ -f "$R/WORK.md" ]] \
  && grep -q -- '--add-label dispatch/done' <(ghlog) \
  && grep -q 'issue close 5' <(ghlog) \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == done ]] \
  && ok "IS1 merge → ラベル遷移 → close → state 終端" || fail "IS1 (rc=$rc) $out"
teardown

# IS2: ★ **終端ラベルを先に付け、in-progress はそのあとで外す。**間で落ちても issue には
#      結末が付いた状態で残る。逆順だと「in-progress でも done でもない」宙ぶらりんの
#      issue ができ、次の実行の候補にも入らない。
#      ★ **`terminal` という名前のラベルを付けてはならない。**cmux 版の `terminal` は
#      「終端ラベル」を指す変数名であって、ラベル名ではない。存在しないラベルを付けると
#      `gh issue edit` が落ち、全 issue の遷移が失敗する（実機で発見）。
setup; worker_done succeeded done
run_issue >/dev/null 2>&1
lines=$(grep 'label' <(ghlog))
first=$(head -1 <<<"$lines")
[[ "$first" == *'--add-label dispatch/done'* ]] \
  && [[ "$(grep -n -- '--remove-label dispatch/in-progress' <<<"$lines" | head -1 | cut -d: -f1)" -gt 1 ]] \
  && ! grep -qE -- '--add-label terminal( |$)' <<<"$lines" \
  && ok "IS2 終端ラベルが先、in-progress の除去はあと、terminal ラベルは付けない" \
  || fail "IS2 ($lines)"
teardown

# IS3: ★ **worker が failed なら merge を試みない。**壊れた成果を親へ入れない。
setup; worker_done failed error
out=$(run_issue 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && [[ ! -f "$R/WORK.md" ]] \
  && grep -q -- '--add-label dispatch/failed' <(ghlog) \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == failed ]] \
  && [[ -d "$R/.dispatch/issue-5-x" ]] \
  && ok "IS3 worker が失敗したら merge しない・資源は残す" || fail "IS3 (rc=$rc) $out"
teardown

# IS4: ★ **merge できなければ資源を残し、done にしない。**worktree もブランチも記録も残る。
setup; worker_done succeeded done
# 親を汚して merge の dirty ガードを踏ませる
echo dirt > "$R/dirty.txt"
out=$(run_issue 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && [[ "$(jq -r '.merged' "$R/.dispatch/issue-5-x/integration-result.json")" == false ]] \
  && grep -q -- '--add-label dispatch/failed' <(ghlog) \
  && ! grep -q 'issue close' <(ghlog) \
  && [[ -d "$R/.dispatch/issue-5-x" ]] \
  && ok "IS4 merge できなければ close せず資源を残す" || fail "IS4 (rc=$rc) $out"
teardown

# IS5: ★ **ラベルを動かせなければ state を嘘で上書きしない。**次の reconcile が痕跡を
#      見て止まるほうが、静かに done にするより良い。
setup; worker_done succeeded done
printf '1\n' > "$GH_STUB_DIR/issue_edit.rc"
out=$(run_issue 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == dispatched ]] \
  && [[ "$out" == *'the state is left as dispatched'* ]] \
  && ok "IS5 ラベルを動かせなければ state を嘘で上書きしない" || fail "IS5 (rc=$rc) $out"
teardown

# IS6: ★ **この経路は資源を消さない。**無人で走る側が消すと、失敗の証拠がその場で失われる。
#      片付けは Step 5 の判定とユーザー承認を経た Step 6 の仕事である。
setup; worker_done succeeded done
run_issue >/dev/null 2>&1
[[ -d "$R/.dispatch/issue-5-x" ]] \
  && ! grep -qE 'worktree rm|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "IS6 成功しても資源を消さない" || fail "IS6"
teardown

# IS7: dispatch 自体が起きなければ、そこで終端へ落として資源を残す。
setup
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
out=$(run_issue 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && grep -q -- '--add-label dispatch/failed' <(ghlog) \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == failed ]] \
  && ok "IS7 起動できなければ終端へ落として残す" || fail "IS7 (rc=$rc) $out"
teardown

# IS8: 使用法エラーは 2（運べなかった 1 と区別する）。
setup
bash "$P/bin/orca-issue.sh" --state-file "$SF" --issue abc --slug s --request-file "$REQ" >/dev/null 2>&1
[[ $? -eq 2 ]] || fail "IS8 非数値の --issue"
bash "$P/bin/orca-issue.sh" --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "IS8 使用法エラーは 2" || fail "IS8 unknown option"
teardown

# IS9: ★ **反対の終端ラベルを外す。**1 度失敗して再実行した issue には
#      `dispatch/failed` が付いている。外さないと done と failed が同時に付き、
#      **人が結末を読めなくなる**（実機で発見）。
setup; worker_done succeeded done
run_issue >/dev/null 2>&1
l=$(ghlog)
[[ "$(grep -c -- '--add-label dispatch/done' <<<"$l")" -eq 1 ]] \
  && grep -q -- '--remove-label dispatch/failed' <<<"$l" \
  && ok "IS9 反対の終端ラベルを外す" || fail "IS9 ($l)"
teardown

# IS10: ★ **成功時にも message を書く。**`finalize` は空 message を無視するので、
#       前回の失敗理由が `done` のまま残る（実機で発見）。
setup; worker_done succeeded done
# 先に失敗の痕跡を state へ入れておく
bash "$P/skills/orca-team-dispatch-task/scripts/issue-fetch.sh" --state-file "$SF" \
  finalize --issue 5 --status failed --message "an earlier failure" >/dev/null 2>&1
run_issue >/dev/null 2>&1
m=$(jq -r '.issues["5"].message' "$SF")
[[ "$(jq -r '.issues["5"].status' "$SF")" == done && "$m" != "an earlier failure" ]] \
  && ok "IS10 成功時に古い失敗理由が残らない" || fail "IS10 (message=$m)"
teardown

# IS11: ★ **`--phase dispatch` は待たない。**待つと 1 件ずつ直列にしか走らず、
#       「同時に扱う issue 数」が意味を失う（Stage A の並列 dispatch が使われない）。
setup; worker_done succeeded done
out=$(run_issue --phase dispatch 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && ! grep -q -- '--ack' "$ORCA_STUB_DIR/calls.log" \
  && [[ ! -f "$R/WORK.md" ]] \
  && ! grep -q 'issue close' <(ghlog) \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == dispatched ]] \
  && grep -q '^status_dir=' <<<"$out" \
  && ok "IS11 dispatch phase は待たず merge もしない" || fail "IS11 (rc=$rc) $out"
teardown

# IS12: `--phase finish` は dispatch し直さず、待機済みの状態から merge して終端へ運ぶ。
setup; worker_done succeeded done
run_issue --phase dispatch >/dev/null 2>&1
# 呼び出し側が 1 回で待つ（バッチではここが全件ぶん 1 回）
bash "$P/bin/orca-wait.sh" --status-dir "$R/.dispatch/issue-5-x" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
: > "$ORCA_STUB_DIR/calls.log"; : > "$GH_STUB_DIR/calls.log"
out=$(bash "$P/bin/orca-issue.sh" --state-file "$SF" --issue 5 --slug issue-5-x \
        --repo-root "$R" --phase finish 2>&1); rc=$?
[[ "$rc" -eq 0 && -f "$R/WORK.md" ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && grep -q 'issue close 5' <(ghlog) \
  && [[ "$(jq -r '.issues["5"].status' "$SF")" == done ]] \
  && ok "IS12 finish phase は dispatch し直さず終端へ運ぶ" || fail "IS12 (rc=$rc) $out"
teardown

# IS13: finish は **dispatch の記録が無ければ運ばない**（何も無いところから成功にしない）。
setup
out=$(bash "$P/bin/orca-issue.sh" --state-file "$SF" --issue 5 --slug issue-5-x \
        --repo-root "$R" --phase finish 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'there is no dispatch state'* ]] \
  && ok "IS13 記録が無ければ finish しない" || fail "IS13 (rc=$rc) $out"
teardown

# IS14: 不正な --phase は使用法エラー（2）。
setup
bash "$P/bin/orca-issue.sh" --state-file "$SF" --issue 5 --slug s --request-file "$REQ" \
  --phase bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "IS14 不正な --phase は 2" || fail "IS14"
teardown

# IS15: ★ **`2>&1` で受けても機械可読行は 1 組だけ。**呼び出し側は進捗を見るために
#       stderr を混ぜる。複製されると `--run` に改行入りの値が渡って次の issue が
#       起動しない（実機で発見）。
setup; worker_done succeeded done
out=$(run_issue --phase dispatch 2>&1)
[[ "$(grep -c '^run_id=' <<<"$out")" -eq 1 ]] \
  && [[ "$(grep -c '^status_dir=' <<<"$out")" -eq 1 ]] \
  && ok "IS15 2>&1 でも機械可読行は 1 組" || fail "IS15 ($out)"
teardown

# IS16: ★ **親が dirty なら dispatch の時点で言う。**merge の dirty ガードは finish まで
#       発火しないので、黙って進むと **必ず merge できない仕事に worker を 1 本使う**。
#       止めはしない（間に commit されうる）が、無人実行で気づけるようにする。
setup; worker_done succeeded done
echo dirt > "$R/dirty.txt"
out=$(run_issue --phase dispatch 2>&1); rc=$?
[[ "$rc" -eq 0 ]] && [[ "$out" == *'the parent checkout is dirty'* ]] \
  && grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "IS16 dirty を dispatch 時に警告し、止めはしない" || fail "IS16 (rc=$rc) $out"
teardown

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
