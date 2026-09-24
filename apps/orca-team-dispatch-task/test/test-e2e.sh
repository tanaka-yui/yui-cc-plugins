#!/usr/bin/env bash
# canonical path を stub の上で 1 本通す。git と worktree は本物を使う。
set -uo pipefail
# ★ テストは **走らせる機械の WSL 状態に依存させない**。実 WSL2 上ではこの変数が
#   実環境から入っており、既定経路が host path 変換に化ける
unset ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
export ORCA_TERMINAL_HANDLE=term_p
# ★ 利用者の実 config を読ませない (test-start.sh と同じ理由)
export ORCA_DISPATCH_CONFIG_HOME="$ORCA_STUB_DIR/config"
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
echo '{"ok":true,"result":{"task":{"id":"task_e"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_e","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_w"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
echo '{"ok":true,"result":{"runId":"run_e","count":0,"messages":[]}}' > "$ORCA_STUB_DIR/orchestration_check"
echo '{"ok":true,"result":{"worker":{"state":"active"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/orchestration_worker-retain"
echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"

# ★ **spec 文字列ではなく呼び出し行を見る。**worker へ渡す spec に `--ack` の語が
#   入っているので、calls.log を素で grep すると task-create の 1 行に当たる。
ack_lines() { grep -E '^orchestration check ' "$ORCA_STUB_DIR/calls.log" | grep -c -- '--ack'; }
ack_lineno() { grep -nE '^orchestration check ' "$ORCA_STUB_DIR/calls.log" | grep -- '--ack' | head -1 | cut -d: -f1; }
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
  {id:"m1",type:"worker_done",payload:({taskId:"task_e",dispatchId:"ctx_e",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
out=$(bash "$P/bin/orca-wait.sh" --status-dir "$SD" --max-waits 1 --timeout-ms 1 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *"outcome=succeeded"* ]] && ok "E6 成功で完了" || fail "E6 (rc=$rc)"
# **retain してから ack している**（解放は Step 6 だけの権限。spec D12）
r=$(grep -n 'worker-retain' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
a=$(ack_lineno)
[[ -n "$r" && -n "$a" && "$r" -lt "$a" ]] && ! grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "E7 retain が ack より前・release しない" || fail "E7 順序 ($r/$a)"

node "$P/bin/orca-merge.ts" --status-dir "$SD" >/dev/null 2>&1
git -C "$R" show main:README.md | grep -q "$MARK" && ok "E8 成果が親ブランチへ" || fail "E8 merge されない"
# **merge しても資源は消さない**（Stage 1 は片付けを自動化しない）
[[ -d "$WT" ]] && git -C "$R" show-ref --quiet refs/heads/orca/e2e \
  && ok "E9 資源を消さない" || fail "E9 資源を消した"
# **ownership と terminal 集合を記録している**（片付けの gate が読む）
jq -e '.roles.design.worktree_created_by_this_run == true
       and (.roles.design.worktree_terminals | index("term_w") != null)' "$SD/workers.json" >/dev/null 2>&1 \
  && ok "E11 ownership と端末集合を記録" || fail "E11 ($(jq -c . "$SD/workers.json"))"
# 親の checkout は clean のまま（.dispatch/ が除外されている）
[[ -z "$(git -C "$R" status --porcelain)" ]] && ok "E10 親が clean" || fail "E10 親が dirty"

# --- 2 タスクを 1 つの Run で並列に流す ---
WT2=$(mktemp -d)/wt2; git -C "$R" worktree add -q -b orca/e2e-b "$WT2" >/dev/null 2>&1
REQ2=$(mktemp); printf 'second task\n' > "$REQ2"
: > "$ORCA_STUB_DIR/calls.log"

# 1 本目（Run を作る）
echo '{"ok":true,"result":{"task":{"id":"task_a"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_a","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_a"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
printf '{"ok":true,"result":{"worktree":{"id":"wt_a","path":"%s","branch":"refs/heads/orca/e2e"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
OUTA=$(bash "$P/bin/orca-start.sh" --request-file "$REQ" --slug pa --objective o --repo-root "$R" 2>&1)
SDA=$(sed -n 's/^status_dir=//p' <<<"$OUTA"); RUNID=$(sed -n 's/^run_id=//p' <<<"$OUTA")

# 2 本目（同じ Run に相乗り）
echo '{"ok":true,"result":{"task":{"id":"task_b"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_b","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_b"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
printf '{"ok":true,"result":{"worktree":{"id":"wt_b","path":"%s","branch":"refs/heads/orca/e2e-b"}}}\n' \
  "$WT2" > "$ORCA_STUB_DIR/worktree_create"
OUTB=$(bash "$P/bin/orca-start.sh" --request-file "$REQ2" --slug pb --objective o --repo-root "$R" \
         --run "$RUNID" 2>&1)
SDB=$(sed -n 's/^status_dir=//p' <<<"$OUTB")

[[ -n "$SDA" && -n "$SDB" && "$(grep -c 'run-create' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "E12 2 タスクが 1 つの Run に載る" || fail "E12 (a=$SDA b=$SDB)"

# 1 batch に 2 件の worker_done が同居する
echo '{"status":"done"}' > "$SDA/roles/design/status.json"
echo '{"status":"done"}' > "$SDB/roles/design/status.json"
jq -nc '{ok:true,result:{runId:"run_e",deliveryId:"de",count:2,messages:[
  {id:"e1",type:"worker_done",payload:({taskId:"task_a",dispatchId:"ctx_a",outcome:"succeeded"}|tojson),body:""},
  {id:"e2",type:"worker_done",payload:({taskId:"task_b",dispatchId:"ctx_b",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
: > "$ORCA_STUB_DIR/calls.log"
bash "$P/bin/orca-wait.sh" --status-dir "$SDA" --status-dir "$SDB" --max-waits 1 --timeout-ms 1 >/dev/null 2>&1
rc=$?
[[ "$rc" -eq 0 \
   && "$(jq -c . "$SDA/received.json")" == '["worker_done|task_a|ctx_a|succeeded"]' \
   && "$(jq -c . "$SDB/received.json")" == '["worker_done|task_b|ctx_b|succeeded"]' \
   && "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 \
   && "$(ack_lines)" -eq 1 ]] \
  && ok "E13 1 batch で 2 件を振り分け、retain 2 回・ack 1 回" || fail "E13 (rc=$rc)"

git -C "$R" worktree remove --force "$WT2" >/dev/null 2>&1
rm -rf "$REQ2" "$(dirname "$WT2")"

# ── レビューモード: 2 役を起こし、1 往復を通し、両方を drain する ──────────────
# ★ **ここが本節の目的。**reviewer の worker_done を未知として扱った瞬間、drain は ack
#   せずに戻り、**design の成果まで取り出せなくなる**。stub で通しに固定する。
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
printf '%s\n' '{"review_mode":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
WTD=$(mktemp -d)/wtd; git -C "$R" worktree add -q -b orca/rv "$WTD" >/dev/null 2>&1
WTR=$(mktemp -d)/wtr; git -C "$R" worktree add -q -b orca/rv-review "$WTR" >/dev/null 2>&1
cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/rvn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/rvn"
if [ "\$n" = 1 ]; then
  printf '{"ok":true,"result":{"worktree":{"id":"wt_rv_r","path":"%s","branch":"refs/heads/orca/rv-review"}}}\n' "$WTR" > "$ORCA_STUB_DIR/worktree_create"
else
  printf '{"ok":true,"result":{"worktree":{"id":"wt_rv_d","path":"%s","branch":"refs/heads/orca/rv"}}}\n' "$WTD" > "$ORCA_STUB_DIR/worktree_create"
fi
HOOK
chmod +x "$ORCA_STUB_DIR/worktree_create.hook"
cat > "$ORCA_STUB_DIR/orchestration_task-create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/tcn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/tcn"
if [ "\$n" = 1 ]; then t=task_rv_r; else t=task_rv_d; fi
printf '{"ok":true,"result":{"task":{"id":"%s"}}}\n' "\$t" > "$ORCA_STUB_DIR/orchestration_task-create"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_task-create.hook"
cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/wsn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/wsn"
if [ "\$n" = 1 ]; then d=ctx_rv_r; h=term_rv_r; else d=ctx_rv_d; h=term_rv_d; fi
printf '{"ok":true,"result":{"state":"ready","dispatchId":"%s","effects":[{"kind":"terminal","role":"agent","action":"created","id":"%s"}]}}\n' \
  "\$d" "\$h" > "$ORCA_STUB_DIR/orchestration_worker-start"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"

REQ3=$(mktemp); MARK3="E2E-RV-$$-$RANDOM"; printf 'Build %s\n' "$MARK3" > "$REQ3"
: > "$ORCA_STUB_DIR/calls.log"
OUT3=$(bash "$P/bin/orca-start.sh" --request-file "$REQ3" --slug rv --objective o \
         --repo-root "$R" --run run_e 2>&1); rc=$?
SDR=$(sed -n 's/^status_dir=//p' <<<"$OUT3")
[[ "$rc" -eq 0 && -n "$SDR" ]] && ok "E14 review_mode=on で 2 役が起きる" || fail "E14 ($rc): $OUT3"

# 起動順は reviewer が先（design は起動直後に依頼しうる。spec 5-1 T4a）
[[ "$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)" == *'id:wt_rv_r'* ]] \
  && ok "E15 reviewer を先に起こす" || fail "E15"

# 役ごとに別の worktree・別のブランチ
[[ "$(jq -r '.roles.design.worktree_id' "$SDR/workers.json")" == wt_rv_d \
   && "$(jq -r '.roles.design_review.worktree_id' "$SDR/workers.json")" == wt_rv_r \
   && "$(jq -r '.roles.design.branch' "$SDR/workers.json")" == orca/rv \
   && "$(jq -r '.roles.design_review.branch' "$SDR/workers.json")" == orca/rv-review ]] \
  && ok "E16 役ごとに別の worktree とブランチ" || fail "E16 ($(jq -c .roles "$SDR/workers.json"))"

# review dir はタスク単位で共有（ロール別 status dir の外）
[[ -d "$SDR/review" && ! -d "$SDR/roles/design/review" ]] \
  && ok "E17 review dir はタスク単位で共有" || fail "E17"

# ── 1 往復。design が依頼し、reviewer が verdict を返す ──
export ORCA_TERMINAL_HANDLE=term_rv_d
printf '%s\n' '{"ok":true,"result":{"message":{"id":"msg_req"}}}' > "$ORCA_STUB_DIR/orchestration_send"
printf 'plan for %s\n' "$MARK3" > "$SDR/review/round-1-request.md"
node "$P/bin/orca-send.ts" --workers "$SDR/workers.json" --to design_review \
  --subject 'review-plan: round 1' --body "$SDR/review/round-1-request.md" >/dev/null 2>&1
sent_rc=$?
[[ "$sent_rc" -eq 0 ]] \
  && grep -q 'dispatch:ctx_rv_r' <(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log") \
  && ok "E18 design の依頼が reviewer の dispatch へ向く" || fail "E18 (rc=$sent_rc)"

export ORCA_TERMINAL_HANDLE=term_rv_r
printf 'looks fine\n\nVERDICT: approved\n' > "$SDR/review/round-1-findings.md"
node "$P/bin/orca-send.ts" --workers "$SDR/workers.json" --to design \
  --subject 'review-verdict: round 1' --body "$SDR/review/round-1-findings.md" >/dev/null 2>&1
vrc=$?
[[ "$vrc" -eq 0 ]] \
  && grep -q 'dispatch:ctx_rv_d' <(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log") \
  && [[ "$(tail -1 "$SDR/review/round-1-findings.md")" == 'VERDICT: approved' ]] \
  && ok "E19 reviewer の verdict が design の dispatch へ返る" || fail "E19 (rc=$vrc)"
export ORCA_TERMINAL_HANDLE=term_p

# ── 待機。1 batch に 2 役の worker_done が同居しても両方を drain し、ack は 1 回 ──
mkdir -p "$SDR/roles/design" "$SDR/roles/design_review"
echo '{"status":"done"}' > "$SDR/roles/design/status.json"
echo '{"status":"done"}' > "$SDR/roles/design_review/status.json"
jq -nc '{ok:true,result:{runId:"run_e",deliveryId:"drv",count:2,messages:[
  {id:"r1",type:"worker_done",payload:({taskId:"task_rv_r",dispatchId:"ctx_rv_r",outcome:"succeeded"}|tojson),body:""},
  {id:"r2",type:"worker_done",payload:({taskId:"task_rv_d",dispatchId:"ctx_rv_d",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
: > "$ORCA_STUB_DIR/calls.log"
WOUT=$(bash "$P/bin/orca-wait.sh" --status-dir "$SDR" --max-waits 1 --timeout-ms 1 2>&1); rc=$?
[[ "$rc" -eq 0 ]] \
  && [[ "$(grep -c 'worker-retain' "$ORCA_STUB_DIR/calls.log")" -eq 2 ]] \
  && [[ "$(grep -c -- '--ack drv' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(jq -r 'sort | join(",")' "$SDR/received.json")" \
        == 'worker_done|task_rv_d|ctx_rv_d|succeeded,worker_done|task_rv_r|ctx_rv_r|succeeded' ]] \
  && ok "E20 2 役を 1 batch で drain し retain 2 回・ack 1 回" || fail "E20 (rc=$rc) $WOUT"

# 出力は役ごとに 1 行。**どちらが失敗したか名指しできる**ことが Step 3 / Step 4 の前提である
[[ "$WOUT" == *'role=design '* && "$WOUT" == *'role=design_review '* ]] \
  && ok "E21 待機の出力が役ごとに 1 行" || fail "E21 ($WOUT)"

rm -f "$ORCA_STUB_DIR/worktree_create.hook" "$ORCA_STUB_DIR/orchestration_task-create.hook" \
      "$ORCA_STUB_DIR/orchestration_worker-start.hook"
git -C "$R" worktree remove --force "$WTD" >/dev/null 2>&1
git -C "$R" worktree remove --force "$WTR" >/dev/null 2>&1
rm -rf "$REQ3" "$(dirname "$WTD")" "$(dirname "$WTR")"

# ── issue モード: claim → dispatch → merge → ラベル遷移 → close を 1 本通す ──────
# ★ **merge が通って初めて close する**という順序が、この節で固定したいことである。
# 前の節が置いた review_mode=on を引き継がない（この節の stub は 1 役ぶんしか無い）
rm -f "$ORCA_DISPATCH_CONFIG_HOME/config.json"
GH_STUB_DIR="$ORCA_STUB_DIR/gh"; mkdir -p "$GH_STUB_DIR"; : > "$GH_STUB_DIR/calls.log"
IBIN="$ORCA_STUB_DIR/ibin"; mkdir -p "$IBIN"
{ echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/gh-stub.sh"; } > "$IBIN/gh"
chmod +x "$IBIN/gh"; export GH_STUB_DIR; E2E_OLD_PATH="$PATH"; PATH="$IBIN:$PATH"; export PATH
export LOOP_SESSION_ID=e2e-issue DISPATCH_DIR="$R/.dispatch" LOOP_REPO_ROOT="$R"
: > "$GH_STUB_DIR/issue_edit"; : > "$GH_STUB_DIR/issue_close"
jq -nc '[{name:"dispatch/in-progress"}]' > "$GH_STUB_DIR/label_list"
jq -nc '[{number:42,title:"Fix the thing",body:"please",url:"u42",labels:[]}]' > "$GH_STUB_DIR/issue_list"

IFS_SH="$P/skills/orca-team-dispatch-task/scripts/issue-fetch.sh"
ISTATE="$R/.dispatch-issue/state.json"
bash "$IFS_SH" --state-file "$ISTATE" lock-acquire --lease-min 30 >/dev/null 2>&1
bash "$IFS_SH" --state-file "$ISTATE" init --config-json '{}' --filter-json '{}' >/dev/null 2>&1
bash "$IFS_SH" --state-file "$ISTATE" ensure-labels >/dev/null 2>&1
CLAIM=$(bash "$IFS_SH" --state-file "$ISTATE" fetch --limit 1 --batch 1 2>/dev/null)
ISLUG=$(jq -r '.[0].slug' <<<"$CLAIM")
[[ "$(jq -r '.[0].number' <<<"$CLAIM")" == 42 && "$ISLUG" == issue-42-* ]] \
  && grep -q -- '--add-label dispatch/in-progress' "$GH_STUB_DIR/calls.log" \
  && ok "E22 issue を claim して slug を割り当てる" || fail "E22 ($CLAIM)"

# claim した slug の worktree を用意し、成果を commit しておく
WTI=$(mktemp -d)/wti; git -C "$R" worktree add -q -b "orca/$ISLUG" "$WTI" >/dev/null 2>&1
echo fixed > "$WTI/FIX.md"; git -C "$WTI" add -A
git -C "$WTI" -c user.email=t@e -c user.name=t commit -q -m fix
printf '{"ok":true,"result":{"worktree":{"id":"wt_i","path":"%s","branch":"refs/heads/orca/%s"}}}\n' \
  "$WTI" "$ISLUG" > "$ORCA_STUB_DIR/worktree_create"
echo '{"ok":true,"result":{"worktrees":[]}}' > "$ORCA_STUB_DIR/worktree_list"
echo '{"ok":true,"result":{"task":{"id":"task_i"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
rm -f "$ORCA_STUB_DIR/orchestration_task-create.hook" "$ORCA_STUB_DIR/worktree_create.hook"
cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<HOOK
#!/usr/bin/env bash
mkdir -p "$R/.dispatch/$ISLUG/roles/design"
printf '{"status":"done"}\n' > "$R/.dispatch/$ISLUG/roles/design/status.json"
printf 'fixed it\n' > "$R/.dispatch/$ISLUG/roles/design/result.md"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_i","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_i"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
jq -nc '{ok:true,result:{runId:"run_e",deliveryId:"dis",count:1,messages:[
  {id:"i1",type:"worker_done",payload:({taskId:"task_i",dispatchId:"ctx_i",outcome:"succeeded"}|tojson),body:""}]}}' \
  > "$ORCA_STUB_DIR/orchestration_check"
IREQ=$(mktemp); jq -r '.[0] | "\(.title)\n\n\(.body)"' <<<"$CLAIM" > "$IREQ"

: > "$ORCA_STUB_DIR/calls.log"
# claim 時の add-label が残っていると「最初の add-label」が別物になる
: > "$GH_STUB_DIR/calls.log"
IOUT=$(bash "$P/bin/orca-issue.sh" --state-file "$ISTATE" --issue 42 --slug "$ISLUG" \
         --request-file "$IREQ" --repo-root "$R" --max-waits 1 --timeout-ms 1 2>&1); irc=$?
[[ "$irc" -eq 0 && -f "$R/FIX.md" ]] \
  && [[ "$(jq -r '.merged' "$R/.dispatch/$ISLUG/integration-result.json")" == true ]] \
  && ok "E23 issue の成果が親へ merge される" || fail "E23 (rc=$irc) $IOUT"

# 終端ラベルが先、in-progress の除去はあと。close は merge のあと。
# **`terminal` という名前のラベルは作らないし付けない**（実機で発見した誤り）。
ghl=$(cat "$GH_STUB_DIR/calls.log")
first_label=$(grep 'label' <<<"$ghl" | head -1)
[[ "$first_label" == *'--add-label dispatch/done'* ]] \
  && grep -q -- '--remove-label dispatch/in-progress' <<<"$ghl" \
  && ! grep -qE -- '--add-label terminal( |$)' <<<"$ghl" \
  && grep -q 'issue close 42' <<<"$ghl" \
  && ok "E24 終端ラベルが先、close は merge のあと" || fail "E24 ($first_label)"

[[ "$(jq -r '.issues["42"].status' "$ISTATE")" == done ]] \
  && ok "E25 state が終端 done に落ちる" || fail "E25"

# ★ **この経路は資源を消さない。**片付けは Step 5 の判定と Step 6 の承認を経る
[[ -d "$R/.dispatch/$ISLUG" ]] \
  && ! grep -qE 'worktree rm|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "E26 issue モードでも資源は消さない" || fail "E26"

bash "$IFS_SH" --state-file "$ISTATE" lock-release >/dev/null 2>&1
git -C "$R" worktree remove --force "$WTI" >/dev/null 2>&1
rm -f "$ORCA_STUB_DIR/orchestration_worker-start.hook"
PATH="$E2E_OLD_PATH"; export PATH
unset GH_STUB_DIR LOOP_SESSION_ID DISPATCH_DIR LOOP_REPO_ROOT
rm -rf "$IREQ" "$(dirname "$WTI")"

git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
rm -rf "$ORCA_STUB_DIR" "$R" "$REQ" "$(dirname "$WT")"
echo "---"; echo "failures: $fails"; exit "$fails"
