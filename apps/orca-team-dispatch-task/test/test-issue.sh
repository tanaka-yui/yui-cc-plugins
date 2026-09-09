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

# IS2: ★ **終端ラベルを先に付ける。**`dispatch/done` を付ける前に落ちても、`terminal` が
#      付いていれば「この issue はもう回さない」と後から読める。
setup; worker_done succeeded done
run_issue >/dev/null 2>&1
first=$(grep -n 'add-label' <(ghlog) | head -1)
[[ "$first" == *'add-label terminal'* ]] \
  && ok "IS2 終端ラベルを先に付ける" || fail "IS2 ($first)"
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

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
