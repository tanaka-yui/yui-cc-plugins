#!/usr/bin/env bash
# canonical path を stub の上で 1 本通す。git と worktree は本物を使う。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
export ORCA_TERMINAL_HANDLE=term_p
R=$(mktemp -d); git -C "$R" init -q -b main .; echo seed > "$R/README.md"
git -C "$R" add -A; git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
# worker の worktree は **repo の外**（中に置くと親が常に dirty になる。実測）
WT=$(mktemp -d)/wt; git -C "$R" worktree add -q -b orca/e2e "$WT" >/dev/null 2>&1
# 依頼は **status dir の外**から渡す。start が写さなければ E3 が落ちる
REQ=$(mktemp); MARK="E2E-$$-$RANDOM"; printf 'Append %s to README.md\n' "$MARK" > "$REQ"
echo '{"ok":true,"result":{"runtime":{"reachable":true}}}' > "$ORCA_STUB_DIR/status"
echo '{"ok":true,"result":{"terminal":{"handle":"term_p"}}}' > "$ORCA_STUB_DIR/terminal_show"
echo '{"ok":true,"result":{"run":{"id":"run_e"}}}' > "$ORCA_STUB_DIR/orchestration_run-create"
echo '{"ok":true,"result":{"run":{"id":"run_e","coordinator_handle":"term_p"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"
echo '{"ok":true,"result":{"worktrees":[]}}' > "$ORCA_STUB_DIR/worktree_list"
printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/e2e"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
echo '{"ok":true,"result":{"terminal":{"handle":"term_w"}}}' > "$ORCA_STUB_DIR/terminal_create"
echo '{"ok":true,"result":{"task":{"id":"task_e"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_e"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
echo '{"ok":true,"result":{"runId":"run_e","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
echo '{"ok":true,"result":{"state":"retained"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"

OUT=$(bash "$P/bin/orca-start.sh" --request-file "$REQ" --slug e2e --objective o \
        --repo-root "$R" 2>&1); rc=$?
SD=$(sed -n 's/^status_dir=//p' <<<"$OUT")
[[ "$rc" -eq 0 && -n "$SD" ]] && ok "E1 start" || { fail "E1 start ($rc): $OUT"; SD="$R/.dispatch/e2e"; }
grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | grep -q "$MARK" \
  && ok "E2 依頼が worker へ届く" || fail "E2 依頼が Task spec に無い"
grep -q "$MARK" "$SD/request.md" 2>/dev/null && ok "E3 materialize" || fail "E3 materialize されない"
# **launch が worker checkout を汚さない**
[[ -z "$(git -C "$WT" status --porcelain)" ]] && ok "E4 checkout を汚さない" || fail "E4 checkout が dirty"
bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
[[ $? -ne 0 ]] && ok "E5 黙っていれば完了しない" || fail "E5 早すぎる完了"

# worker がやることを再現する
printf '%s\n' "$MARK" >> "$WT/README.md"; git -C "$WT" add -A
git -C "$WT" -c user.email=t@e -c user.name=t commit -q -m work
printf 'appended %s\n' "$MARK" > "$SD/roles/design/result.md"
echo '{"status":"done"}' > "$SD/roles/design/status.json"
jq -nc '{ok:true,result:{runId:"run_e",deliveryId:"d1",count:1,messages:[
  {id:"m1",type:"worker_done",payload:{taskId:"task_e",dispatchId:"ctx_e",outcome:"succeeded"},body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] && ok "E6 成功で完了" || fail "E6 (rc=$rc)"
# **release してから ack している**（Orca guide の既定。retain は使わない）
r=$(grep -n 'worker-release' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(grep -n -- '--ack' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ! grep -q 'worker-retain' "$ORCA_STUB_DIR/calls.log" \
  && ok "E7 release が ack より前" || fail "E7 順序 ($r/$a)"

bash "$P/bin/orca-merge.sh" --status-dir "$SD" >/dev/null 2>&1
git -C "$R" show main:README.md | grep -q "$MARK" && ok "E8 成果が親ブランチへ" || fail "E8 merge されない"
# **merge しても資源は消さない**（Stage 1 は片付けを自動化しない）
[[ -d "$WT" ]] && git -C "$R" show-ref --quiet refs/heads/orca/e2e \
  && ok "E9 資源を消さない" || fail "E9 資源を消した"
# **ownership と terminal 集合を記録している**（片付けの gate が読む）
jq -e '.worktree_created_by_this_run == true
       and (.worktree_terminals | index("term_w") != null)' "$SD/workers.json" >/dev/null 2>&1 \
  && ok "E11 ownership と端末集合を記録" || fail "E11 ($(jq -c . "$SD/workers.json"))"
# 親の checkout は clean のまま（.dispatch/ が除外されている）
[[ -z "$(git -C "$R" status --porcelain)" ]] && ok "E10 親が clean" || fail "E10 親が dirty"

git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
rm -rf "$ORCA_STUB_DIR" "$R" "$REQ" "$(dirname "$WT")"
echo "---"; echo "failures: $fails"; exit "$fails"
