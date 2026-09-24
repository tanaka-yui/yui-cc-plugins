#!/usr/bin/env bash
# worker の起動。**他人の資源を触らない**ことと、**成功していないのに成功を返さない**こと。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
# ★ テストは **走らせる機械の WSL 状態に依存させない**。実 WSL2 上ではこの変数が
#   実環境から入っており、既定経路が host path 変換に化ける。WSL 経路は ST16* が明示的に張る
unset ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND
setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"
  # ★ **利用者の実 config を読ませない。**隔離しないと、その端末で --setup を一度でも
  #   走らせた瞬間にテストの期待 (agent=claude / model 無し) が壊れる
  export ORCA_DISPATCH_CONFIG_HOME="$ORCA_STUB_DIR/config"
  export ORCA_TERMINAL_HANDLE=term_p
  R=$(mktemp -d); git -C "$R" init -q -b main .
  echo seed > "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  # ★ worker の worktree は **repo の外**。中に置くと親が常に dirty になる（実測）
  WT=$(mktemp -d)/wt; git -C "$R" worktree add -q -b orca/s "$WT" >/dev/null 2>&1
  REQ=$(mktemp); MARK="MARK-$$"; printf 'do %s\n' "$MARK" > "$REQ"
  echo '{"ok":true,"result":{"runtime":{"reachable":true}}}' > "$ORCA_STUB_DIR/status"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_p"}}}' > "$ORCA_STUB_DIR/terminal_show"
  echo '{"ok":true,"result":{"run":{"id":"run_x"}}}' > "$ORCA_STUB_DIR/orchestration_run-create"
  echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_p"}}}' \
    > "$ORCA_STUB_DIR/orchestration_run-current"
  echo '{"ok":true,"result":{"worktrees":[]}}' > "$ORCA_STUB_DIR/worktree_list"
  printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' \
    "$WT" > "$ORCA_STUB_DIR/worktree_create"
  echo '{"ok":true,"result":{"task":{"id":"task_x"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_w"}]}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-start"
}
teardown() { git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
             rm -rf "$ORCA_STUB_DIR" "$R" "$REQ" "$(dirname "$WT")"
             unset ORCA_TERMINAL_HANDLE ORCA_BIN ORCA_DISPATCH_CONFIG_HOME; }
start() { bash "$P/bin/orca-start.sh" --request-file "$REQ" --slug "${SLUG:-s}" --objective obj \
            --repo-root "$R" "$@"; }
spec() { grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | head -1; }
# ★ **実機の receipt に `name` は無い**（実測 2026-09-09）。名前は `displayName` に載る。
#   fixture が `name` を持っていたせいで、再利用経路のテストが全部「嘘の形」で通っていた。
reuse_fixture() { printf '{"ok":true,"result":{"worktrees":[{"id":"wt_old","displayName":"s","path":"%s","branch":"refs/heads/orca/s"}]}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_list"; }

setup; bash "$P/bin/orca-start.sh" --bogus >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "ST1 使用法エラー" || fail "ST1"; teardown

# ST1b: **0 byte の依頼は worker へ送らない。**本文を失った dispatch を開始しない。
setup; : > "$REQ"; out=$(start 2>&1); rc=$?
[[ "$rc" -eq 2 && "$out" == *"--request-file must not be empty"* \
  ]] && ! grep -q 'run-create' "$ORCA_STUB_DIR/calls.log" 2>/dev/null \
  && ok "ST1b 空の依頼を拒否" || fail "ST1b (rc=$rc out=$out)"; teardown

# ST2: **親の handle が無ければ何も作らない。**候補が 1 つでも推測しない (O26)
setup; unset ORCA_TERMINAL_HANDLE; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST2 handle 不明で何も作らない" || fail "ST2 handle を推測した"; teardown

# ST3: **slug を fail closed に検証する。**`../` で .dispatch の外を対象にできてはならない
setup; SLUG='../../etc' start >/dev/null 2>&1
[[ $? -eq 2 ]] && ! grep -q 'worktree' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST3 traversal slug を拒否" || fail "ST3 traversal slug を受理した"; teardown
setup; SLUG='Bad_Slug' start >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "ST3b 不正な文字を拒否" || fail "ST3b 不正な slug を受理した"; teardown

# ST4: **依頼本文が task-create --spec に載る。**worker へ届く唯一の経路。
#      lifecycle の argv も全部持つ (spec 6-4b)。bare orca は使わせない (O1)
setup; start >/dev/null 2>&1; l=$(spec); miss=""
[[ "$l" == *"$MARK"* ]] || miss="$miss [request]"
# ★ 'ORCA_BIN' は入れない。**変数名が spec に出ること自体がバグ**である（ST42）。
for n in 'worker_done' '--task-id' '--dispatch-id' '--dispatch-capability' \
         '--from' '--outcome' 'report-status.sh' 'dispatch-show --task'; do
  [[ "$l" == *"$n"* ]] || miss="$miss [$n]"; done
[[ "$l" == *' orca orchestration'* ]] && miss="$miss [bare-orca]"
[[ -z "$miss" ]] && ok "ST4 依頼と lifecycle argv" || fail "ST4 欠落:$miss"; teardown

# ST4b: **ask / escalation を使わせない。**Stage 1 の親はそれを処理できない
setup; start >/dev/null 2>&1; l=$(spec)
[[ "$l" == *'do not send'* || "$l" == *'Do not send'* ]] && [[ "$l" == *escalation* ]] \
  && ok "ST4b ask/escalation を禁じる" || fail "ST4b 禁止が書かれていない"; teardown

# ST5: Run の束縛先が自分でなければ起動しない (O26)。workers.json が identity を持つ。
#      worker-start は --agent を渡す。**--setup skip を渡す**
setup; echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_o"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"; start >/dev/null 2>&1
grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" && fail "ST5 無関係な Run で起動した"; teardown
setup; start >/dev/null 2>&1
jq -e '.run_id=="run_x" and .roles.design.worktree_id=="wt_1" and .roles.design.branch=="orca/s"
       and .integration_branch=="main"
       and .roles.design.terminal=="term_w" and .roles.design.task=="task_x" and .roles.design.dispatch=="ctx_x"' \
  "$R/.dispatch/s/workers.json" >/dev/null 2>&1 || fail "ST5 workers.json"
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
wc_=$(grep 'worktree create' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$ws" == *--agent* && "$wc_" == *'--setup skip'* ]] \
  && ok "ST5 束縛・identity・agent・setup skip" || fail "ST5 (ws=$ws wc=$wc_)"; teardown

# ST6: **worktree の再利用は親 repo で絞る**（`--repo` は受け付けない）
setup; start >/dev/null 2>&1
wl=$(grep 'worktree list' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$wl" == *"--repo path:$R"* ]] && ok "ST6 親 repo で絞る" || fail "ST6 ($wl)"; teardown
setup; start --repo other >/dev/null 2>&1
[[ $? -eq 2 ]] && ok "ST6c --repo を受け付けない" || fail "ST6c --repo を受理した"; teardown

# ST6d: **list に失敗したら「不在」と解釈しない**（fail closed）
setup; echo 1 > "$ORCA_STUB_DIR/worktree_list.rc"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6d inspection 失敗で作らない" || fail "ST6d 失敗を不在と読んだ"; teardown

# ST6e: **再利用先が dirty なら渡さない**（前回の未完了変更を成果へ混ぜない）
setup; reuse_fixture; echo dirt > "$WT/dirty.txt"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6e dirty な再利用を拒否" || fail "ST6e dirty を渡した"; teardown

# ST6f: **rc 非 0 なのに receipt らしき JSON を返す create を成功にしない**
setup; echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6f create の rc を見る" || fail "ST6f rc を無視した"; teardown

# ST6b: 同名が複数返ったら曖昧として止まる（勝手に 1 件目を選ばない）
setup; printf '{"ok":true,"result":{"worktrees":[{"id":"a","displayName":"s","path":"%s","branch":"refs/heads/orca/s"},{"id":"b","displayName":"s","path":"/tmp/other","branch":"refs/heads/x"}]}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_list"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6b 曖昧なら止まる" || fail "ST6b 1 件目を勝手に選んだ"; teardown

# ST8: **worker-start は rc 0 + state=ready + dispatch id の 3 つ揃いを要求する。**
#      failed の receipt に dispatchId が残っていても成功にしない。
#      ただし **返ってきた dispatch id は disk に残す** — 記録しないと、その worker の
#      worker_done が共有 Delivery に居座り、兄弟タスクの wait が永久に ack できなくなる
did_on_disk() { jq -r '.roles.design.dispatch // empty' "$R/.dispatch/s/workers.json" 2>/dev/null; }
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_x"}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(did_on_disk)" == "ctx_x" ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8 failed receipt を成功にせず削除もせず、dispatch は残す" \
  || fail "ST8 (rc=$rc dispatch='$(did_on_disk)')"; teardown
setup; echo '{"ok":true,"result":{"state":"outcome_unknown","dispatchId":"ctx_x"}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"; start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(did_on_disk)" == "ctx_x" ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8b outcome_unknown も同じ" || fail "ST8b (rc=$rc dispatch='$(did_on_disk)')"; teardown
setup; echo '{"ok":true,"result":{"state":"ready"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
start >/dev/null 2>&1; rc=$?
# dispatch id 自体が返っていないので、記録するものが無い。捏造もしない
[[ "$rc" -eq 1 && -z "$(did_on_disk)" ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8c ready でも dispatch id が無ければ KEPT" || fail "ST8c (rc=$rc)"; teardown

# ST9: **Task 未作成の段の write 失敗 → identity を出し、自分が作った分だけ戻す**
#      端末は worker-start より後にしか生まれないので、この段では terminal=none
setup; out=$(ORCA_FAIL_WRITE_AT=workers-worktree-design start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && [[ "$out" == *"worktree=wt_1"* && "$out" == *"terminal=none"* ]] \
  && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9 identity を出して自分の分だけ戻す" || fail "ST9 (rc=$rc out=$out)"; teardown

# ST9c: ★ **骨格を書けない段では worktree をまだ作っていない。**tuple の記録は Run の直後
#       （どの役の資源よりも前）なので、ここで落ちても戻すものが無い。
setup; out=$(ORCA_FAIL_WRITE_AT=workers-initial start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"Nothing else exists yet"* ]] \
  && ! grep -qE 'worktree create|worktree rm|task-create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9c 骨格を書けない段では何も作っていない" || fail "ST9c (rc=$rc out=$out)"; teardown

# ST9b: **Task 成立後の write 失敗は KEPT。**この境界では何も消してはならない。
#       failpoint は呼び出し地点 ID で撃つ — basename 比較では Task 前と区別できない
setup; out=$(ORCA_FAIL_WRITE_AT=workers-after-task-design start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && [[ "$out" == *"task=task_x"* && "$out" == *KEPT* ]] \
  && grep -q 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9b Task 成立後は KEPT で何も消さない" || fail "ST9b (rc=$rc out=$out)"; teardown

# ST9a: task-create が task id を返したなら、rc 非 0 でも Task の不在を断定せず、何も削除しない。
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_task-create.rc"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"task-create failed for design (rc=1) but returned task id task_x"* \
  && "$out" == *"Resources are KEPT"* && "$out" == *"task=task_x"* ]] \
  && ! grep -q 'terminal close\|worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9a task id 付きの task-create 失敗は KEPT" || fail "ST9a (rc=$rc out=$out)"; teardown

# ST9a2: rc 0 で task id が無い receipt は Task 不在を証明しない。何も cleanup しない。
setup; echo '{"ok":true,"result":{"task":{}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"task-create returned success but no task id for design"* && "$out" == *KEPT* \
  && "$out" == *"worktree=wt_1"* && "$out" == *"terminal=none"* \
  && "$out" == *"task-list --run run_x"* ]] \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9a2 曖昧な task-create は KEPT" || fail "ST9a2 (rc=$rc out=$out)"; teardown

# ST9b2: **Dispatch 成立後の write 失敗も同じ**
setup; out=$(ORCA_FAIL_WRITE_AT=workers-after-dispatch-design start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && [[ "$out" == *"dispatch=ctx_x"* && "$out" == *KEPT* ]] \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9b2 Dispatch 成立後も KEPT" || fail "ST9b2 (rc=$rc out=$out)"; teardown

# ST9b3: **Run だけの段では run id を出し、worktree すら作っていない。**
#        提示する inspection の argv は実 CLI と一致すること — `run-show --id`。
#        `--run` は現行 CLI に存在しない
setup; out=$(ORCA_FAIL_WRITE_AT=run start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && [[ "$out" == *"run=run_x"* ]] \
  && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$out" == *"run-show --id run_x"* ]] && [[ "$out" != *"run-show --run"* ]] \
  && ok "ST9b3 Run だけの段と run-show の argv" || fail "ST9b3 (rc=$rc out=$out)"; teardown

# ST9c: **再利用した worktree は write 失敗でも消さない**
setup; reuse_fixture; ORCA_FAIL_WRITE_AT=workers-initial start >/dev/null 2>&1
! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" && ok "ST9c 再利用分は消さない" \
  || fail "ST9c 他人の worktree を消した"; teardown

# ST9d: **正常系は成功を返す**
setup; out=$(start 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *status_dir=* ]] && ok "ST9d 正常系" || fail "ST9d (rc=$rc)"; teardown

# ST10: **`.dispatch/` を info/exclude へ入れる。**入れないと親が常に dirty になり、
#       merge の dirty ガードが必ず発火する（実測で見つけた欠陥）
setup; start >/dev/null 2>&1
grep -qxF '.dispatch/' "$R/.git/info/exclude" 2>/dev/null \
  && [[ -z "$(git -C "$R" status --porcelain)" ]] \
  && ok "ST10 .dispatch を除外して親を clean に保つ" || fail "ST10 親が dirty のまま"; teardown

# ST11: **worker checkout を汚さない。**端末は Orca が作るので、このプロセスは
#       worker checkout に何も書き込んではならない
setup; start >/dev/null 2>&1
[[ -z "$(git -C "$WT" status --porcelain)" ]] \
  && ok "ST11 worker checkout を汚さない" || fail "ST11 worker checkout を汚した"; teardown

# ST14: **ownership と worktree の端末集合を記録する**（片付けの gate が読む）
setup; echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"},{"handle":"term_shell"}]}}' \
  > "$ORCA_STUB_DIR/terminal_list"; start >/dev/null 2>&1
jq -e '.roles.design.worktree_created_by_this_run == true
       and (.roles.design.worktree_terminals | length == 2)' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14 作成 worktree と端末集合" || fail "ST14 ($(jq -c . "$R/.dispatch/s/workers.json"))"; teardown
setup; reuse_fixture; start >/dev/null 2>&1
jq -e '.roles.design.worktree_created_by_this_run == false' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14b 再利用は owned=false" || fail "ST14b 再利用を owned にした"; teardown

# ST14c: **terminal list に失敗したら空配列ではなく null を記録する** (round 4 finding 1)。
#        [] にすると、あとの cleanup gate が「未 account 0」と読んで削除を許す
setup; echo 1 > "$ORCA_STUB_DIR/terminal_list.rc"; start >/dev/null 2>&1
jq -e '.roles.design.worktree_terminals == null' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14c inventory 失敗は null" \
  || fail "ST14c ($(jq -c '.roles.design.worktree_terminals' "$R/.dispatch/s/workers.json"))"; teardown

# ST14d: schema が配列でないときも null
setup; echo '{"ok":true,"result":{"terminals":"nope"}}' > "$ORCA_STUB_DIR/terminal_list"
start >/dev/null 2>&1
jq -e '.roles.design.worktree_terminals == null' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14d 不正 schema も null" || fail "ST14d"; teardown

# ST13: 既存 slug は上書きしない
setup; mkdir -p "$R/.dispatch/s"; echo x > "$R/.dispatch/s/keep"; start >/dev/null 2>&1
[[ $? -ne 0 && -f "$R/.dispatch/s/keep" ]] && ok "ST13 既存 slug を拒否" || fail "ST13 上書きした"; teardown

# ST20: 端末は Orca に作らせる。terminal create / terminal wait を呼ばない
setup; start >/dev/null 2>&1
! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal wait' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST20 端末を自分で作らない" || fail "ST20 terminal create を呼んだ"; teardown

# ST21: worker-start は --agent を渡し、--terminal を渡さない
setup; start >/dev/null 2>&1; l=$(grep 'orchestration worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$l" == *--agent* && "$l" == *claude* && "$l" != *--terminal* ]] \
  && ok "ST21 worker-start の argv" || fail "ST21 ($l)"; teardown

# ST22: 端末 handle は worker-start の receipt から取る
setup; start >/dev/null 2>&1
[[ "$(jq -r '.roles.design.terminal' "$R/.dispatch/s/workers.json")" == "term_w" ]] \
  && ok "ST22 receipt から handle を取る" || fail "ST22"; teardown

# ST23: rc 0 でも handle が無ければ資源を残して止まる。**推測しない**。
#       この時点で dispatch は確実に存在する（ready + id あり）ので、**id を捨てない**
setup; echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x","effects":[]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"Resources are KEPT"* && "$(did_on_disk)" == "ctx_x" ]] \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST23 handle 不明で資源と dispatch を残す" \
  || fail "ST23 (rc=$rc dispatch='$(did_on_disk)' out=$out)"; teardown

# ST24: --run を渡したら run-create を呼ばず、束縛だけ確かめる
setup; start --run run_x >/dev/null 2>&1
! grep -q 'run-create' "$ORCA_STUB_DIR/calls.log" \
  && grep -q 'run-current' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST24 Run に相乗りする" || fail "ST24"; teardown

# ST25: 相乗り先が自分に束縛されていなければ何も作らない
setup
echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_other"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"
out=$(start --run run_x 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST25 他人の Run に相乗りしない" || fail "ST25 (rc=$rc out=$out)"; teardown

# ST26: 相乗り先の id が食い違ったら止める
setup
echo '{"ok":true,"result":{"run":{"id":"run_other","coordinator_handle":"term_p"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"
start --run run_x >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "ST26 別 Run への相乗りを拒否" || fail "ST26 (rc=$rc)"; teardown

# ST27: run_id を stdout に印字する（2 本目以降が使う）
setup; out=$(start 2>/dev/null)
[[ "$out" == *"run_id=run_x"* ]] && ok "ST27 run_id を印字" || fail "ST27 ($out)"; teardown


# --- WSL2 ---
# Orca 本体は Windows 側で動くので、CLI 境界で path 形式が変わる（実測）:
#   送り: `path:` selector が Linux path だと repo_not_found になる
#   受け: receipt の path は UNC で返り、bash の -d も git -C も解釈できない
# ここでは wslpath を差し替えて、その両方向の変換だけを見る。
setup_wsl() {
  setup
  STUBBIN=$(mktemp -d)
  cat > "$STUBBIN/wslpath" <<'WP'
#!/usr/bin/env bash
[[ -n "${WSLPATH_BROKEN:-}" ]] && exit 1
case "$1" in
  -w) printf '%s%s\n' '\\wsl.localhost\Test' "$(printf '%s' "$2" | tr '/' '\\')" ;;
  -u) v="$2"; v="${v#'\\wsl.localhost\Test'}"; printf '%s\n' "$v" | tr '\\' '/' ;;
  *)  exit 2 ;;
esac
WP
  chmod +x "$STUBBIN/wslpath"
  OLDPATH="$PATH"; PATH="$STUBBIN:$PATH"; export PATH
  export ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND=wsl
  WT_WIN=$(wslpath -w "$WT")
  printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' \
    "$(printf '%s' "$WT_WIN" | sed 's|\\|\\\\|g')" > "$ORCA_STUB_DIR/worktree_create"
  echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
}
teardown_wsl() { PATH="$OLDPATH"; export PATH; rm -rf "$STUBBIN"
                 unset ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND WSLPATH_BROKEN; teardown; }

# ST28: **repo selector を host 形式で送る。**Linux path のままだと Orca は repo_not_found を返す
setup_wsl; start >/dev/null 2>&1
if grep -F 'worktree' "$ORCA_STUB_DIR/argv.log" | grep -qF 'path:\\wsl.localhost\Test'; then
  ok "ST28 repo selector を host path で送る"
else
  fail "ST28 repo selector が Linux path のまま ($(grep -F worktree "$ORCA_STUB_DIR/argv.log" | head -1))"
fi; teardown_wsl

# ST28b: **receipt の path を local 形式へ戻す。**戻さないと -d も git -C も落ち、
#        workers.json に bash が使えない path が残って片付け ([C3] の git -C "$WP") が壊れる
setup_wsl; start >/dev/null 2>&1
got=$(jq -r '.roles.design.worktree_path // empty' "$R/.dispatch/s/workers.json" 2>/dev/null)
[[ "$got" == "$WT" ]] && ok "ST28b receipt の path を local へ戻す" \
  || fail "ST28b workers.json の path=[$got] 期待=[$WT]"; teardown_wsl

# ST28c: **変換できなければ何も作らない。**推測した path で他人の repo を触らせない
setup_wsl; WSLPATH_BROKEN=1 start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'run-create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST28c 変換失敗なら何も作らない" || fail "ST28c (rc=$rc)"; teardown_wsl

# ST28d: **wslpath が無ければ変換しない。**HOST_KIND だけを根拠に変換すると、
#        wslpath の無い環境で全 path が空文字になり、誤った checkout を触りうる
setup; export ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND=wsl
OLDPATH="$PATH"
if WPD=$(command -v wslpath 2>/dev/null); then
  WPD=$(dirname "$WPD")
  PATH=$(printf '%s' "$OLDPATH" | tr ':' '\n' | grep -vxF "$WPD" | tr '\n' ':'); PATH="${PATH%:}"
  export PATH
fi
start >/dev/null 2>&1
got=$(jq -r '.roles.design.worktree_path // empty' "$R/.dispatch/s/workers.json" 2>/dev/null)
PATH="$OLDPATH"; export PATH; unset ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND
[[ "$got" == "$WT" ]] && ok "ST28d wslpath が無ければ変換しない" \
  || fail "ST28d path=[$got] 期待=[$WT]"; teardown

# ST29: **ORCA_BIN 未設定なら ORCA_CLI_COMMAND を使う。**WSL2 の Orca は PATH 上の
#       `orca-ide` を export する。macOS の固定 path 決め打ちでは起動できない
setup; STUBBIN=$(mktemp -d)
{ echo '#!/usr/bin/env bash'; printf 'exec %q "$@"\n' "$P/test/lib/orca-stub.sh"; } > "$STUBBIN/orca-ide"
chmod +x "$STUBBIN/orca-ide"
OLDPATH="$PATH"; PATH="$STUBBIN:$PATH"; export PATH
unset ORCA_BIN; export ORCA_CLI_COMMAND=orca-ide
start >/dev/null 2>&1; rc=$?
PATH="$OLDPATH"; export PATH; rm -rf "$STUBBIN"; unset ORCA_CLI_COMMAND
[[ "$rc" -eq 0 ]] && grep -q 'run-create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST29 ORCA_CLI_COMMAND を既定にする" || fail "ST29 (rc=$rc)"; teardown

# ST30: **config が worker-start の argv になる。**ここが繋がっていなければ、
#       config.json はただのファイルであって設定ではない
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
echo '{"roles":{"design":{"agent":"codex","model":"gpt-6-astra","effort":"xhigh"}}}' \
  > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$ws" == *'--agent codex'* && "$ws" == *'--model gpt-6-astra'* && "$ws" == *'--effort xhigh'* ]] \
  && ok "ST30 config が --agent/--model/--effort になる" || fail "ST30 [$ws]"; teardown

# ST31: ★ **設定ゼロなら design は既定 tuple で起動する。**lib/config.ts の既定が
#       worker-start の argv まで届いていることを固定する
setup; start >/dev/null 2>&1
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
printf -v qm '%q' 'claude-opus-5-5[1m]'
[[ "$ws" == *'--agent claude'* && "$ws" == *"--model $qm"* && "$ws" == *'--effort max'* ]] \
  && ok "ST31 設定ゼロなら既定の model/effort を渡す" || fail "ST31 [$ws]"; teardown

# ST32: ★ **壊れた設定では資源を 1 つも作らない。**設定の解決は worktree と Task より前。
#       あとで落ちると、片付けの要る残骸だけが残る
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; echo '{not json' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -qE 'worktree create|task-create|worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST32 壊れた設定では何も作らない" || fail "ST32 (rc=$rc)"; teardown

# ST33: 解決した tuple を workers.json に残す。receipt 無しで「何で走ったか」に答えるため。
#       未設定の model/effort は**キーを置かない**（未設定と空文字を混ぜない）
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
#      （既定 agent 以外なら effort の既定は付かない）
echo '{"roles":{"design":{"agent":"codex","model":"gpt-6-sol"}}}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1
d=$(jq -c '.roles.design | {agent,model,effort:(has("effort"))}' "$R/.dispatch/s/workers.json" 2>/dev/null)
[[ "$d" == '{"agent":"codex","model":"gpt-6-sol","effort":false}' ]] \
  && ok "ST33 解決した tuple を workers.json に残す" || fail "ST33 [$d]"; teardown

# ST34: 1 回きりの上書きは config より強い。config を書き換えずに 1 回だけ別の値で試せる
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
echo '{"roles":{"design":{"agent":"claude","model":"sonnet","effort":"low"}}}' \
  > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start --model 'opus[1m]' --effort max >/dev/null 2>&1
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
# calls.log は argv を %q で記録するので、期待値も同じ引用を通してから比べる
printf -v qm '%q' 'opus[1m]'
[[ "$ws" == *"--model $qm"* && "$ws" == *'--effort max'* ]] \
  && ok "ST34 1 回きりの上書きが config より強い" || fail "ST34 [$ws]"; teardown

# ST40: ★ **worktree の名前は receipt の `displayName` から引く。**実機の
#       `worktree list` に `name` は存在せず（実測 2026-09-09）、`.name` で照合していた間
#       この経路は常に 0 件で、再利用も「同名が複数」の防御も一度も動いていなかった。
setup; reuse_fixture; start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(jq -r '.roles.design.worktree_id' "$R/.dispatch/s/workers.json")" == wt_old ]] \
  && [[ "$(jq -r '.roles.design.worktree_created_by_this_run' "$R/.dispatch/s/workers.json")" == false ]] \
  && ok "ST40 displayName で既存 worktree を再利用する" || fail "ST40 (rc=$rc)"; teardown

# ST42: ★ **worker へ渡す spec に `$ORCA_BIN` を書かない。**worker の shell にその変数は
#       無い（実測 2026-09-09: worker が「$ORCA_BIN was empty; used orca-ide」と報告した）。
#       変数名のまま渡すと、STATUS PROTOCOL の worker_done が空コマンドとして落ちる。
setup; start >/dev/null 2>&1
sp=$(spec)
[[ "$sp" != *'$ORCA_BIN'* ]] && [[ "$sp" == *"$ORCA_BIN"* ]] \
  && ok "ST42 spec は ORCA_BIN の実値を焼き込む" || fail "ST42 [$(printf '%.200s' "$sp")]"; teardown

# --- review_mode=on の 2 ロール起動 (Stage B) ---
review_on() {
  mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
  printf '%s\n' '{"review_mode":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
  # 2 つ目の worktree を create が返せるようにする（1 回目=reviewer, 2 回目=design）
  WT2=$(mktemp -d)/wt2; git -C "$R" worktree add -q -b orca/s-review "$WT2" >/dev/null 2>&1
  cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/n" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/n"
if [ "\$n" = 1 ]; then
  printf '{"ok":true,"result":{"worktree":{"id":"wt_r","path":"%s","branch":"refs/heads/orca/s-review"}}}\n' "$WT2" > "$ORCA_STUB_DIR/worktree_create"
else
  printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' "$WT" > "$ORCA_STUB_DIR/worktree_create"
fi
HOOK
  chmod +x "$ORCA_STUB_DIR/worktree_create.hook"
}
ws_lines() { grep 'worker-start' "$ORCA_STUB_DIR/calls.log"; }

# ST35: ★ **reviewer を先に起こす** (spec 5-1 T4a)。design は起動直後にレビューを依頼しうるので、
#       その時点で reviewer の dispatch が workers.json に無いと依頼が宛先不明になる。
setup; review_on; start >/dev/null 2>&1; rc=$?
first=$(ws_lines | head -1); n=$(ws_lines | wc -l)
[[ "$rc" -eq 0 && "$n" -eq 2 && "$first" == *'id:wt_r'* ]] \
  && ok "ST35 review_mode=on は reviewer を先に 2 本起こす" || fail "ST35 (rc=$rc n=$n first=$first)"; teardown

# ST36: ★ **reviewer が起きなければ design を起こさない。**依頼先の無いレビュー要求で
#       design が待ち続けるより、1 件も起こさないほうが片付けが簡単である。
setup; review_on; echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(ws_lines | wc -l)" -eq 1 ]] \
  && ok "ST36 reviewer が起きなければ design を起こさない" || fail "ST36 (rc=$rc n=$(ws_lines | wc -l))"; teardown

# ST37: ★ **design が失敗しても reviewer の資源は消さない** (Task 成立後は削除しない / O19)。
setup; review_on
cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<'HOOK'
#!/usr/bin/env bash
n=$(cat "$ORCA_STUB_DIR/wsn" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$ORCA_STUB_DIR/wsn"
if [ "$n" = 2 ]; then echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"; fi
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(jq -r '.roles.design_review.dispatch' "$R/.dispatch/s/workers.json")" == ctx_x ]] \
  && ok "ST37 design の失敗で reviewer を消さない" || fail "ST37 (rc=$rc)"; teardown

# ST38: review_mode=off は Stage A のまま worker-start 1 回。
setup; start >/dev/null 2>&1
[[ "$(ws_lines | wc -l)" -eq 1 ]] \
  && [[ "$(jq -r '.roles | keys | join(",")' "$R/.dispatch/s/workers.json")" == design ]] \
  && ok "ST38 review_mode=off は 1 ロールのまま" || fail "ST38"; teardown

# ST39: ★ **2 ロールは別々の worktree を持つ。**同じ checkout に同居させると、reviewer の
#       ビルドやテストが design の編集と衝突する（計画 Task 1 の判断）。
setup; review_on; start >/dev/null 2>&1
d=$(jq -r '.roles.design.worktree_id' "$R/.dispatch/s/workers.json")
r=$(jq -r '.roles.design_review.worktree_id' "$R/.dispatch/s/workers.json")
[[ "$d" == wt_1 && "$r" == wt_r ]] \
  && ok "ST39 ロールごとに別の worktree" || fail "ST39 (design=$d review=$r)"; teardown

# ST43: reviewer の spec は **実装させない**と明示し、design の spec には往復手順が載る。
setup; review_on; start >/dev/null 2>&1
specs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
rv=$(head -1 <<<"$specs"); dz=$(tail -1 <<<"$specs")
miss=""
[[ "$rv" == *'You do not implement anything'* ]] || miss="$miss [reviewer-no-impl]"
[[ "$rv" == *'VERDICT:'* ]] || miss="$miss [reviewer-verdict]"
[[ "$rv" == *'review-plan:'* ]] || miss="$miss [reviewer-waits]"
[[ "$dz" == *'review-plan:'* ]] || miss="$miss [design-requests]"
[[ "$dz" == *'abort-reviewer:'* ]] || miss="$miss [design-releases]"
[[ "$dz" == *'Stop after round 2'* ]] || miss="$miss [round-cap]"
[[ -z "$miss" ]] && ok "ST43 両ロールの spec に往復手順が載る" || fail "ST43:$miss"; teardown

# ST44: review_mode=off なら design の spec に往復手順を**書かない**（居ない相手を指さない）。
setup; start >/dev/null 2>&1
[[ "$(spec)" != *'review-plan:'* ]] && [[ "$(spec)" != *'abort-reviewer:'* ]] \
  && ok "ST44 off の spec に往復手順を書かない" || fail "ST44"; teardown

# ST45: workers.json は **取り込む役**を記録する。merge も PR も同じ値を読む。
setup; start >/dev/null 2>&1
[[ "$(jq -r '.integration_role' "$R/.dispatch/s/workers.json")" == design ]] \
  && ok "ST45 integration_role を記録する" || fail "ST45"; teardown

# --- Phase B 委譲 (F-a) ---
phase_b_on() {
  mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
  printf '%s\n' '{"phase_b":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
  WTX=$(mktemp -d)/wtx; git -C "$R" worktree add -q -b orca/s-exec "$WTX" >/dev/null 2>&1
  cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/pbn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/pbn"
if [ "\$n" = 1 ]; then
  printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' "$WT" > "$ORCA_STUB_DIR/worktree_create"
else
  printf '{"ok":true,"result":{"worktree":{"id":"wt_x","path":"%s","branch":"refs/heads/orca/s-exec"}}}\n' "$WTX" > "$ORCA_STUB_DIR/worktree_create"
fi
HOOK
  chmod +x "$ORCA_STUB_DIR/worktree_create.hook"
}
design_done() {
  mkdir -p "$R/.dispatch/s/roles/design"
  printf '{"status":"done"}\n' > "$R/.dispatch/s/roles/design/status.json"
  printf 'the plan\n' > "$R/.dispatch/s/plan.md"
}
exec_phase() { bash "$P/bin/orca-start.sh" --slug s --repo-root "$R" --phase exec "$@"; }

# ST46: ★ **phase_b=on の design は実装しない。**実装役が別に居るのに両方が書くと、
#       同じ変更が 2 つのブランチに載って取り込みが壊れる。
setup; phase_b_on; start >/dev/null 2>&1
sp=$(spec); miss=""
[[ "$sp" == *'PLAN ONLY'* ]] || miss="$miss [plan-only]"
[[ "$sp" == *'commit nothing'* ]] || miss="$miss [no-commit]"
[[ "$sp" == *'plan.md'* ]] || miss="$miss [names-plan]"
[[ -z "$miss" ]] && ok "ST46 phase_b=on の design は計画だけ" || fail "ST46:$miss"
# 1 段目では exec を起こさない
[[ "$(grep -c 'worker-start' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  || fail "ST46 1 段目で exec を起こした"
teardown

# ST47: exec の spec は plan.md の絶対パスを名指しし、**plan を編集するなと言う**。
setup; phase_b_on; start >/dev/null 2>&1; design_done
: > "$ORCA_STUB_DIR/calls.log"
exec_phase >/dev/null 2>&1; rc=$?
sp=$(spec); miss=""
[[ "$rc" -eq 0 ]] || miss="$miss [rc=$rc]"
[[ "$sp" == *"$R/.dispatch/s/plan.md"* ]] || miss="$miss [absolute-plan-path]"
[[ "$sp" == *'Do not edit'* ]] || miss="$miss [do-not-edit]"
[[ "$sp" == *'commit it on this branch'* ]] || miss="$miss [implements]"
[[ -z "$miss" ]] && ok "ST47 exec の spec は plan を名指しする" || fail "ST47:$miss"
teardown

# ST48: ★ **design が終わっていなければ exec を起こさない。**計画が無いまま実装させない。
setup; phase_b_on; start >/dev/null 2>&1
printf '{"status":"error"}\n' > "$R/.dispatch/s/roles/design/status.json"
printf 'the plan\n' > "$R/.dispatch/s/plan.md"
: > "$ORCA_STUB_DIR/calls.log"
out=$(exec_phase 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'not done'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST48 design が done でなければ exec を起こさない" || fail "ST48 (rc=$rc) $out"
teardown

# ST49: ★ **空の計画で実装させない。**plan.md が無い／空なら exec は何を作るか知らない。
setup; phase_b_on; start >/dev/null 2>&1
mkdir -p "$R/.dispatch/s/roles/design"
printf '{"status":"done"}\n' > "$R/.dispatch/s/roles/design/status.json"
: > "$ORCA_STUB_DIR/calls.log"
out=$(exec_phase 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'plan.md is missing or empty'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" || fail "ST49 plan 不在"
: > "$R/.dispatch/s/plan.md"
out=$(exec_phase 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'plan.md is missing or empty'* ]] \
  && ok "ST49 空の計画では exec を起こさない" || fail "ST49 空 plan (rc=$rc)"
teardown

# ST50: exec は **1 段目の Run を引き継ぎ**、自分の worktree とブランチを持つ。
setup; phase_b_on; start >/dev/null 2>&1; design_done
# ★ **1 段目のログを混ぜない。**「exec 段が run-create を呼んでいない」ことを見たいので、
#   ここで区切らないと 1 段目の run-create を数えてしまう。
: > "$ORCA_STUB_DIR/calls.log"
exec_phase >/dev/null 2>&1
w="$R/.dispatch/s/workers.json"
[[ "$(jq -r '.roles.exec.worktree_id' "$w")" == wt_x ]] \
  && [[ "$(jq -r '.roles.exec.branch' "$w")" == orca/s-exec ]] \
  && [[ "$(jq -r '.roles.design.worktree_id' "$w")" == wt_1 ]] \
  && [[ "$(jq -r '.run_id' "$w")" == run_x ]] \
  && ! grep -qE 'run-create|run-current' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST50 exec は Run を引き継ぎ自分の worktree を持つ" || fail "ST50 ($(jq -c '.roles|keys' "$w"))"
teardown

# ST51: ★ **取り込む役が exec になる。**merge も PR もこの 1 箇所を読む。
setup; phase_b_on; start >/dev/null 2>&1
[[ "$(jq -r '.integration_role' "$R/.dispatch/s/workers.json")" == exec ]] \
  && ok "ST51 phase_b=on なら取り込む役は exec" || fail "ST51"; teardown

# ST52: exec を二重に起こさない（同じ計画から 2 本の実装が走ると取り込みが壊れる）。
setup; phase_b_on; start >/dev/null 2>&1; design_done
exec_phase >/dev/null 2>&1
: > "$ORCA_STUB_DIR/calls.log"
out=$(exec_phase 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'already started'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST52 exec を二重に起こさない" || fail "ST52 (rc=$rc) $out"
teardown

# ST53: phase_b=off で --phase exec を呼んだら、起こす役が無いと言って止まる。
setup; start >/dev/null 2>&1
out=$(exec_phase 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'phase_b is off'* ]] \
  && ok "ST53 phase_b=off では exec 段が無い" || fail "ST53 (rc=$rc) $out"; teardown

# ST54: ★ **役ごとに違う worktree 名を使う。**`design` 以外を一律 `-review` にしていたので、
#       `exec` が `<slug>-review` を名乗り、**review_mode と phase_b を同時に on にすると
#       design_review と衝突した**（実機で発見）。
setup; review_on
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
printf '%s\n' '{"review_mode":"on","phase_b":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1
names=$(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log" | grep -A1 -- '--name' | grep -v -- '--name' | grep -v '^--$' | sort -u)
[[ "$(grep -c 's-design-review' <<<"$names")" -eq 1 ]] \
  && ! grep -qx 's-review' <<<"$names" \
  && ok "ST54 役ごとに違う worktree 名（design_review は s-design-review）" || fail "ST54 [$names]"
teardown

# ST55: 既定では `--setup skip` のまま（setup hook を要する repo は今までどおり対象外）。
setup; start >/dev/null 2>&1
wc_=$(grep 'worktree create' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$wc_" == *'--setup skip'* ]] && ok "ST55 既定は --setup skip" || fail "ST55 [$wc_]"; teardown

# ST56: ★ **setup が失敗した worktree で作業させない。**依存の無いまま実装すると、
#       なぜ失敗したか分からない成果ができる。作った worktree は戻して止まる。
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"setup":"run"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"},"setup":{"state":"failed"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'setup hook did not succeed'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST56 setup 失敗では worker を起こさず戻す" || fail "ST56 (rc=$rc) $out"; teardown

# ST57: setup=run が成功した receipt では今までどおり起動する。
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"setup":"run"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"},"setup":{"state":"succeeded"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
start >/dev/null 2>&1; rc=$?
wc_=$(grep 'worktree create' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && "$wc_" == *'--setup run'* ]] \
  && grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST57 setup=run が成功すれば起動する" || fail "ST57 (rc=$rc)"; teardown

# --- Phase B-R (F-b の残り) ---
four_roles() {
  mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
  printf '%s\n' '{"review_mode":"on","phase_b":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
  for n in 1 2 3 4; do
    eval "W$n=\$(mktemp -d)/w$n"; eval "git -C \"$R\" worktree add -q -b orca/s-$n \"\$W$n\" >/dev/null 2>&1"
  done
  cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/frn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/frn"
eval "p=\\\$W\$n"
printf '{"ok":true,"result":{"worktree":{"id":"wt_%s","path":"%s","branch":"refs/heads/orca/s-%s"}}}\n' "\$n" "\$p" "\$n" > "$ORCA_STUB_DIR/worktree_create"
HOOK
  chmod +x "$ORCA_STUB_DIR/worktree_create.hook"
  export W1 W2 W3 W4
}

# ST58: ★ **exec_review は exec より先に起きる。**exec は起動直後にレビューを依頼しうるので、
#       その時点で宛先が workers.json に無いと詰まる（T4a と同じ理由）。
setup; four_roles; start >/dev/null 2>&1; design_done
: > "$ORCA_STUB_DIR/calls.log"
exec_phase >/dev/null 2>&1; rc=$?
order=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | sed 's/.*--worktree \([^ ]*\).*/\1/')
w=$(jq -r '.roles | keys | join(",")' "$R/.dispatch/s/workers.json")
[[ "$rc" -eq 0 ]] && [[ "$(wc -l <<<"$order")" -eq 2 ]] \
  && [[ "$w" == "design,design_review,exec,exec_review" ]] \
  && ok "ST58 2 段目は exec_review → exec の順で 2 本" || fail "ST58 (rc=$rc order=[$order] roles=$w)"
teardown

# ST59: ★ **依頼のラベルとファイル名を役ごとに分ける。**design は review-plan: / plan-*、
#       exec は review-code: / code-*。**2 人の reviewer が同じ findings 名を使うと
#       片方の findings を上書きする。**
setup; four_roles; start >/dev/null 2>&1
# review_mode=on の 1 段目は design_review → design の順なので、design の spec は 2 本目
dsp=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | tail -1)
drv=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | head -1)
design_done; : > "$ORCA_STUB_DIR/calls.log"; exec_phase >/dev/null 2>&1
specs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
xrv=$(head -1 <<<"$specs"); xsp=$(tail -1 <<<"$specs")
miss=""
[[ "$dsp" == *'review-plan:'* ]] || miss="$miss [design-label]"
[[ "$dsp" == *'plan-round-<n>-request.md'* ]] || miss="$miss [design-file]"
[[ "$drv" == *'plan-round-<n>-findings.md'* ]] || miss="$miss [design-reviewer-file]"
[[ "$drv" == *'--to design'* ]] || miss="$miss [design-reviewer-target]"
[[ "$xsp" == *'review-code:'* ]] || miss="$miss [exec-label]"
[[ "$xsp" == *'code-round-<n>-request.md'* ]] || miss="$miss [exec-file]"
[[ "$xrv" == *'code-round-<n>-findings.md'* ]] || miss="$miss [exec-reviewer-file]"
[[ "$xrv" == *'--to exec'* ]] || miss="$miss [exec-reviewer-target]"
[[ -z "$miss" ]] && ok "ST59 役ごとにラベルとファイル名を分ける" || fail "ST59:$miss"
teardown

# ST60: ★ **spec に渡すコマンドが、そのまま shell で動く形になっていること。**
#       ヒアドキュメントとダブルクォート文字列でエスケープの段数が違うので、片方だけ 1 段多いと
#       `"\$ORCA_TERMINAL_HANDLE"` のような**展開されない変数**や、行末に `\\` が並んだ**壊れた継続行**が
#       worker へ渡る。★ **spec は複数行なので、1 行ずつではなく spec 全体を見る**（以前の版は `read` で
#       1 行ずつ読んでいたので、行をまたぐ `\\` + 改行を一度も検出できなかった。2026-09-24 に design の
#       レビュー手順で 3 件見つかった: 行末の `\\`、描画時に展開された親の handle（`"\term_..."`）、
#       レビュー手順の最後の行と次の段落が改行なしで繋がる）
setup; four_roles; start >/dev/null 2>&1; design_done; exec_phase >/dev/null 2>&1
bad=""; n=0
while IFS= read -r -d $'\036' sp; do
  n=$((n + 1))
  [[ "$sp" == *'\$ORCA_TERMINAL_HANDLE'* ]] && bad="$bad [escaped-var]"
  [[ "$sp" == *'\\'$'\n'* ]] && bad="$bad [double-continuation]"
  [[ "$sp" == *'--terminal "\'* ]] && bad="$bad [expanded-handle]"
  if [[ "$sp" == *"the work is finished'"* && "$sp" != *"the work is finished'"$'\n\n'* ]]; then
    bad="$bad [glued-paragraph]"
  fi
  # 依頼側のレビュー手順は、worker 自身のメールボックスを待つ（親の handle を埋め込まない）
  if [[ "$sp" == *'REVIEW PROTOCOL'* && "$sp" != *'check --terminal "$ORCA_TERMINAL_HANDLE" \'$'\n'* ]]; then
    bad="$bad [own-mailbox]"
  fi
done < <(awk -v RS='\037' 'prev == "--spec" { printf "%s\036", $0 } { prev = $0 }' "$ORCA_STUB_DIR/argv.log")
[[ "$n" -eq 4 && -z "$bad" ]] && ok "ST60 spec のコマンドがそのまま動く形になっている" || fail "ST60 (n=$n):$bad"
teardown
# ST61: 既定 (direct) では取りかかり方の指示を足さない — **現行の挙動を変えない**。
setup; start >/dev/null 2>&1
sp=$(spec)
[[ "$sp" != *'superpowers:brainstorming'* ]] && [[ "$sp" != *'Decide the approach before'* ]] \
  && ok "ST61 direct は指示を足さない" || fail "ST61"; teardown

# ST62: brainstorm は superpowers の skill を名指しし、**質問の出し方まで指定する**。
#       ★ 以前ここは「答えが無くても止まるな」を固定していた。**実機がそれを覆した** —
#       worker は質問を印字して止まるのではなく `orchestration ask` を使い、親は
#       `orchestration reply` で答えられる。印字しただけの質問は誰にも読まれない。
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"design_mode":"brainstorm"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1; sp=$(spec); miss=""
[[ "$sp" == *'superpowers:brainstorming'* ]] || miss="$miss [skill]"
[[ "$sp" == *'orchestration ask'* ]] || miss="$miss [ask]"
[[ "$sp" == *'not by printing a question and stopping'* ]] || miss="$miss [no-print]"
[[ "$sp" == *'one question at a time'* ]] || miss="$miss [one-at-a-time]"
[[ "$sp" == *'ask once'* ]] && miss="$miss [ask-once-present]"
[[ "$sp" == *'superpowers:writing-plans'* ]] || miss="$miss [writing-plans]"
[[ "$sp" == *'not installed'* ]] || miss="$miss [degrade]"
[[ -z "$miss" ]] && ok "ST62 brainstorm の指示" || fail "ST62:$miss"; teardown

# ST63: ★ **`ask` は許し、escalation は許さない。**親には `reply` の口があるが
#       escalation を処理する口が無い（実測: 親の queue を永久に塞いだ）。
#       direct の spec は ask を勧めない（尋ねる相手が居る前提を作らない）。
setup; start >/dev/null 2>&1; sp=$(spec); miss=""
[[ "$sp" == *'Do not send escalations'* ]] || miss="$miss [no-escalation]"
[[ "$sp" == *'when this task told you to ask'* ]] || miss="$miss [conditional-ask]"
[[ -z "$miss" ]] && ok "ST63 ask は条件付きで許し escalation は許さない" || fail "ST63:$miss"; teardown

# ST64: plan は「触る前に手順を決めて記録せよ」と言う。
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"design_mode":"plan"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1
[[ "$(spec)" == *'Decide the approach before you touch anything'* ]] \
  && ok "ST64 plan の指示" || fail "ST64"; teardown

# ST65: ★ **取りかかり方の指示は design にだけ載る。**exec は計画に従う役であり、
#       reviewer は何も作らない。両方に載せると誰が決めるのか分からなくなる。
setup; review_on
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
printf '%s\n' '{"review_mode":"on","phase_b":"on","design_mode":"brainstorm"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1; design_done; printf 'plan\n' > "$R/.dispatch/s/plan.md"
drv=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | head -1)
: > "$ORCA_STUB_DIR/calls.log"; exec_phase >/dev/null 2>&1
xs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
[[ "$drv" != *'superpowers:brainstorming'* ]] && [[ "$xs" != *'superpowers:brainstorming'* ]] \
  && ok "ST65 取りかかり方の指示は design にだけ" || fail "ST65"; teardown

# ── 待ち方（途中で止まらないこと）────────────────────────────────────────
# ★ **2026-09-10 の停止の本体がここだった。**旧 STATUS PROTOCOL は merge_ready を送った
#   あと "End your turn here" と worker にターンを閉じさせ、"When you are woken" と
#   続けていた。だが `orchestration send` はメールボックスに入れるだけで**アイドルな
#   worker を起こさない** — 1 Run の 4 worker 全員が未読のまま停止した。

# ST66: ★ **ターンを閉じさせない。**この 1 行が入っていた時期の dispatch は必ず止まる。
setup; start >/dev/null 2>&1; sp=$(spec)
[[ "$sp" != *'End your turn here'* ]] \
  && ok "ST66 待つためにターンを閉じさせない" || fail "ST66"; teardown

# ST67: 完了の待機は `completion.sh await` の呼び直しで、その 3 つの答えが spec に載る。
#      **`expired` は載せない** — worker は自分の時計で待機をやめない。
setup; start >/dev/null 2>&1; sp=$(spec); miss=""
for w in 'completion.sh --role-dir' ' await' 'accepted' 'remediation' 'waiting'; do
  [[ "$sp" == *"$w"* ]] || miss="$miss [$w]"; done
[[ "$sp" == *'expired'* ]] && miss="$miss [expired-present]"
[[ -z "$miss" ]] && ok "ST67 await の 3 つの答えが載る" || fail "ST67:$miss"; teardown

# ST68: ★ **`waiting` は呼び直す指示とセットでなければ意味が無い。**「もう一度呼べ」を
#      書かないと、agent は 1 回空振りしただけで自分の判断で降りる。
setup; start >/dev/null 2>&1; sp=$(spec)
[[ "$sp" == *'Run it again'* ]] \
  && ok "ST68 空振りは呼び直させる" || fail "ST68"; teardown

# ST69: レビューの待機にも同じ歯止めを置く（依頼側・reviewer 側の両方）。
setup; review_on; start >/dev/null 2>&1
specs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
rv=$(head -1 <<<"$specs"); dz=$(tail -1 <<<"$specs")
[[ "$rv" == *'Do not end your turn'* ]] && [[ "$dz" == *'Do not end your turn'* ]] \
  && ok "ST69 レビューの待機も閉じさせない" || fail "ST69"; teardown

# ST70: ★ **shell 変数が turn をまたいで生き残る前提を置かない。**worker の bash 呼び出しは
#      1 回ごとに別の shell である。`NONCE=$(... prepare)` を C で置いて D で
#      `$NONCE` を参照する形は、C と D を別々に実行した瞬間に **nonce の無い merge_ready**
#      になり、親が「nonce が無い」と言って **batch ごと詰まる**。記録から読み直させる。
setup; start >/dev/null 2>&1; sp=$(spec)
[[ "$sp" != *'NONCE'* ]] && [[ "$sp" == *' nonce'* ]] \
  && ok "ST70 nonce は記録から読み直す" || fail "ST70"; teardown

# ST71: ★ **判定に使う文字列がそのまま届くこと。**design の spec は二重引用符の中で
#      組み立てられるので、バックティックの escape を 1 つ間違えると「バックスラッシュ +
#      コマンド置換の開始」と読まれ、`review-verdict:` と `VERDICT: approved` が**指示文
#      から消える**（実測 2026-09-10）。消えると design は verdict を判定できない。
setup; review_on; start >/dev/null 2>&1
dz=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | tail -1); miss=""
for w in '`review-verdict:`' '`VERDICT: approved`'; do
  [[ "$dz" == *"$w"* ]] || miss="$miss [$w]"; done
[[ "$dz" != *'\`'* ]] || miss="$miss [escaped-backtick-leaked]"
[[ -z "$miss" ]] && ok "ST71 判定文字列がそのまま載る" || fail "ST71:$miss"; teardown


# ST72: ★ **`waiter_exists` は「レビュー不可」ではない。**Orca は 1 つの Run で待機が
#       競合すると待ちを拒む。実測 2026-09-11: exec はこれを恒久的な失敗と読んで
#       verdict 無しで成果を差し出し、**無レビューのまま succeeded になった**。
#       依頼側にも reviewer 側にも「busy であって不在ではない」を書いておく。
setup
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
printf '%s\n' '{"review_mode":"on","phase_b":"on"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1; design_done
exec_phase >/dev/null 2>&1
# ★ spec は複数行なので **1 本の文字列として見る**。行ごとに読むと、同じ段落の
#   別の行に在る 2 つの目印が決して同時に一致しない
specs=$(awk -v RS='\037' 'prev == "--spec" { print } { prev = $0 }' "$ORCA_STUB_DIR/argv.log")
miss=""
[[ "$specs" == *'`waiter_exists`'* ]] || miss="$miss [no-code-name]"
[[ "$specs" == *'It does not count as an empty'* ]] || miss="$miss [reviewer]"
[[ "$specs" == *'only a `review-skipped:` message justifies that'* ]] || miss="$miss [worker]"
[[ -z "$miss" ]] && ok "ST72 待機の競合は再試行だと両側に書く" || fail "ST72:$miss"; teardown

# ── worktree の基点 ──────────────────────────────────────────────────────
# ★ **`worktree create` に基点を渡す口が無い。**基点を決めるのは Orca であり、実測では
#   先のタスクを親へ取り込んで HEAD が進んだあとに切った worktree が、取り込み前の base の
#   ままだった。そこで実装させると、既に入っている変更を知らないまま働くので持ち帰りで衝突する。
advance() {   # 親 checkout を 1 commit 進める
  printf 'more\n' >> "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m advance
}

# ST73: 親が進んでいたら、作った worktree を親の HEAD まで早送りしてから起動する。
setup; advance
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 && "$(git -C "$WT" rev-parse HEAD)" == "$(git -C "$R" rev-parse HEAD)" ]] \
  && ok "ST73 古い基点を親の HEAD まで早送りする" \
  || fail "ST73 (rc=$rc wt=$(git -C "$WT" rev-parse --short HEAD) rr=$(git -C "$R" rev-parse --short HEAD))"
teardown

# ST74: **祖先関係が無ければ混ぜない。**別の歴史を早送りで繋ぐことはできない。
setup
printf 'theirs\n' > "$WT/OTHER.md"; git -C "$WT" add -A
git -C "$WT" -c user.email=t@e -c user.name=t commit -q -m diverge
advance
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"unrelated to the parent checkout"* ]] \
  && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST74 別の歴史では起動せず、作った worktree を戻す" || fail "ST74 (rc=$rc out=$out)"
teardown

# ST75: **一致していれば何もしない。**正常な起動に余計な操作を足さない。
setup; out=$(start 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" != *"fast-forwarded"* ]] \
  && ok "ST75 一致していれば触らない" || fail "ST75 (rc=$rc out=$out)"
teardown

# ★ **`worktree create` は最初の端末（空のシェル）を必ず 1 枚作る**（実測 2026-09-19）。
#   worker-start は既存 worktree に agent 端末を**別に**作るので、閉じないと空端末が残る。
#   receipt は handle を返さない（startupTerminal=null）ので、worker-start の前に列挙する。
startup_term() { echo '{"ok":true,"result":{"terminals":[{"handle":"term_s"}]}}' > "$ORCA_STUB_DIR/terminal_list"; }
closes() { grep 'terminal close' "$ORCA_STUB_DIR/calls.log" | head -1; }

# ST76: 作った worktree の空端末を、worker が ready になった後にペイン単位で閉じる。
#       `--tab` は付けない — agent が同じタブに split で置かれる設定だと agent ごと閉じる
setup; startup_term; start >/dev/null 2>&1; rc=$?
c=$(closes); ws_n=$(grep -n 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
cl_n=$(grep -n 'terminal close' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ "$rc" -eq 0 && "$c" == *term_s* && "$c" != *--tab* && -n "$cl_n" && "$cl_n" -gt "$ws_n" ]] \
  && ok "ST76 空の最初の端末を worker-start の後に閉じる" || fail "ST76 (rc=$rc close=$c)"; teardown

# ST77: **再利用した worktree の端末には触らない。**人が使っている端末かもしれない
setup; reuse_fixture; startup_term; start >/dev/null 2>&1
[[ -z "$(closes)" ]] && ok "ST77 再利用 worktree の端末は閉じない" || fail "ST77 ($(closes))"; teardown

# ST78: **setup=run では閉じない。**setup hook がどの端末で走るかを証明できない
setup; startup_term
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"setup":"run"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"},"setup":{"state":"succeeded"}}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_create"
start >/dev/null 2>&1
[[ -z "$(closes)" ]] && ok "ST78 setup=run では閉じない" || fail "ST78 ($(closes))"; teardown

# ST79: **1 枚でなければ閉じない。**repo 設定のタブ等と区別できない。列挙失敗も同じ
setup; echo '{"ok":true,"result":{"terminals":[{"handle":"term_s"},{"handle":"term_t"}]}}' \
  > "$ORCA_STUB_DIR/terminal_list"; start >/dev/null 2>&1; a=$(closes); teardown
setup; echo 1 > "$ORCA_STUB_DIR/terminal_list.rc"; start >/dev/null 2>&1; b=$(closes)
[[ -z "$a" && -z "$b" ]] && ok "ST79 1 枚と確定できなければ閉じない" || fail "ST79 (a=$a b=$b)"; teardown

# ST80: **閉じられなくても dispatch は成功のまま。**見た目の問題で worker を失敗扱いにしない
setup; startup_term; echo 1 > "$ORCA_STUB_DIR/terminal_close.rc"; out=$(start 2>&1); rc=$?
[[ "$rc" -eq 0 && -n "$(closes)" && "$out" == *"could not close"* ]] \
  && jq -e '.roles.design.dispatch == "ctx_x"' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST80 close 失敗でも成功を返す" || fail "ST80 (rc=$rc out=$out)"; teardown

# ST81: ★ **exec 段のやり直しで exec_review を二重に起こさない。**exec_review が起きたあと
#       exec の worktree create だけが落ちた（実測 2026-09-19）。やり直しが exec_review から
#       起こし直すと、先に起きた reviewer が workers.json から外れて取り残される。
setup; four_roles; start >/dev/null 2>&1; design_done
cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/frn" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/frn"
rm -f "$ORCA_STUB_DIR/worktree_create.rc"
if [ "\$n" = 4 ]; then
  printf '{"ok":false,"error":{"code":"git_failed","message":"boom"}}\n' > "$ORCA_STUB_DIR/worktree_create"
  echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"; exit 0
fi
[ "\$n" -gt 4 ] && n=4
eval "p=\\\$W\$n"
printf '{"ok":true,"result":{"worktree":{"id":"wt_%s","path":"%s","branch":"refs/heads/orca/s-%s"}}}\n' "\$n" "\$p" "\$n" > "$ORCA_STUB_DIR/worktree_create"
HOOK
exec_phase >/dev/null 2>&1; rc1=$?
: > "$ORCA_STUB_DIR/calls.log"
out=$(exec_phase 2>&1); rc2=$?
w="$R/.dispatch/s/workers.json"
[[ "$rc1" -eq 1 && "$rc2" -eq 0 ]] \
  && [[ "$(grep -c 'worker-start' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(grep -c 'worktree create' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && [[ "$(jq -r '.roles.exec_review.worktree_id' "$w")" == wt_3 ]] \
  && [[ "$(jq -r '.roles.exec.worktree_id' "$w")" == wt_4 ]] \
  && [[ "$out" == *'exec_review has already started'* ]] \
  && ok "ST81 exec 段のやり直しは exec だけを起こす" || fail "ST81 (rc1=$rc1 rc2=$rc2) $out"
teardown

# ST82: **worktree create の失敗理由を言う。**rc だけでは原因が残らない（実測 2026-09-19:
#       stderr を捨てていたので、何が起きたかを誰も読めなかった）。
setup
echo '{"ok":false,"error":{"code":"git_failed","message":"boom"}}' > "$ORCA_STUB_DIR/worktree_create"
echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'worktree create failed for design (rc=1); git_failed: boom'* ]] \
  && ok "ST82 worktree create の失敗理由を出す" || fail "ST82 (rc=$rc) $out"; teardown

# --- runtime_unavailable の後で現れた worktree (実測 2026-09-19、3 回続けて) ---
settle_fast() { export ORCA_CREATE_SETTLE_SECS=3 ORCA_CREATE_SETTLE_INTERVAL=1; }
unavailable() {
  echo '{"ok":false,"error":{"code":"runtime_unavailable","message":"The Orca runtime closed the connection before responding."}}' \
    > "$ORCA_STUB_DIR/worktree_create"
  echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"
}
# 1 回目の list（作る前の確認）は空、2 回目以降は後から現れた worktree を返す
late_list() {
  cat > "$ORCA_STUB_DIR/worktree_list.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/ln" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/ln"
if [ "\$n" -ge 2 ]; then
  printf '{"ok":true,"result":{"worktrees":[{"id":"wt_late","displayName":"s","path":"%s","branch":"refs/heads/orca/s"}]}}\n' "$WT" > "$ORCA_STUB_DIR/worktree_list"
fi
HOOK
  chmod +x "$ORCA_STUB_DIR/worktree_list.hook"
}

# ST83: ★ **接続が切れても、Orca が作り終えた worktree は自分のものとして使う。**作る前に
#       同名が無いことを確かめてあるので、後から現れたものはこの呼び出しが作ったものである。
setup; settle_fast; unavailable; late_list
out=$(start 2>&1); rc=$?
w="$R/.dispatch/s/workers.json"
[[ "$rc" -eq 0 && "$out" == *'adopting it'* ]] \
  && [[ "$(jq -r '.roles.design.worktree_id' "$w")" == wt_late ]] \
  && [[ "$(jq -r '.roles.design.worktree_created_by_this_run' "$w")" == true ]] \
  && grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST83 runtime_unavailable の後に現れた worktree を使う" || fail "ST83 (rc=$rc) $out"
teardown

# ST84: 待っても現れなければ、今までどおり起動しない。
setup; settle_fast; unavailable
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'runtime_unavailable'* && "$out" == *'did not appear'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST84 現れなければ起動しない" || fail "ST84 (rc=$rc) $out"; teardown

# ST85: ★ **setup=run では拾わない。**receipt が無いので setup hook の成否を証明できない。
#       拾った worktree は消さずに残す（Orca が作り終えたものを勝手に消さない）。
setup; settle_fast; unavailable; late_list
mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"; printf '%s\n' '{"setup":"run"}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'cannot verify'* && "$out" == *'KEPT'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST85 setup=run では拾わず残す" || fail "ST85 (rc=$rc) $out"; teardown

# ST86: 接続切れ以外の失敗は待たない（作れなかったと Orca が答えている）。
setup; settle_fast
echo '{"ok":false,"error":{"code":"git_failed","message":"boom"}}' > "$ORCA_STUB_DIR/worktree_create"
echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"
start >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(grep -c 'worktree list' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ok "ST86 接続切れ以外の失敗では待たない" || fail "ST86 (rc=$rc)"; teardown
unset ORCA_CREATE_SETTLE_SECS ORCA_CREATE_SETTLE_INTERVAL

# --- design 段の再開 ---
resume() { bash "$P/bin/orca-start.sh" --slug s --repo-root "$R" --resume "$@"; }

# ST87: ★ **design 段を再開できる。**reviewer が起きたあと design の起動だけが落ちると、
#       status dir が残るので同じ slug では始め直せない（実測 2026-09-19）。--resume は
#       記録済みの依頼と Run を使い、dispatch の無い役だけを起こす。
setup; review_on
cat > "$ORCA_STUB_DIR/worktree_create.hook" <<HOOK
#!/usr/bin/env bash
n=\$(cat "$ORCA_STUB_DIR/n" 2>/dev/null || echo 0); n=\$((n+1)); echo "\$n" > "$ORCA_STUB_DIR/n"
rm -f "$ORCA_STUB_DIR/worktree_create.rc"
case "\$n" in
  1) printf '{"ok":true,"result":{"worktree":{"id":"wt_r","path":"%s","branch":"refs/heads/orca/s-review"}}}\n' "$WT2" > "$ORCA_STUB_DIR/worktree_create" ;;
  2) printf '{"ok":false,"error":{"code":"git_failed","message":"boom"}}\n' > "$ORCA_STUB_DIR/worktree_create"
     echo 1 > "$ORCA_STUB_DIR/worktree_create.rc" ;;
  *) printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' "$WT" > "$ORCA_STUB_DIR/worktree_create" ;;
esac
HOOK
start >/dev/null 2>&1; rc1=$?
req_before=$(cat "$R/.dispatch/s/request.md")
: > "$ORCA_STUB_DIR/calls.log"
out=$(resume 2>&1); rc2=$?
w="$R/.dispatch/s/workers.json"
[[ "$rc1" -eq 1 && "$rc2" -eq 0 ]] \
  && [[ "$(ws_lines | wc -l)" -eq 1 && "$(ws_lines)" == *'id:wt_1'* ]] \
  && [[ "$(jq -r '.roles.design_review.worktree_id' "$w")" == wt_r ]] \
  && [[ "$(jq -r '.roles.design.worktree_id' "$w")" == wt_1 ]] \
  && [[ "$(cat "$R/.dispatch/s/request.md")" == "$req_before" ]] \
  && ! grep -qE 'run-create|run-current' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$out" == *'design_review has already started'* ]] \
  && ok "ST87 --resume は dispatch の無い役だけを起こす" || fail "ST87 (rc1=$rc1 rc2=$rc2) $out"
teardown

# ST88: 再開するものが無ければ何も起こさない。design が起動済み / status dir が無い /
#       exec 段に付けた、のいずれでも止まる。
setup; out=$(resume 2>&1); rc=$?
a=""; [[ "$rc" -eq 1 && "$out" == *'nothing to resume'* ]] && a=y; teardown
setup; start >/dev/null 2>&1; : > "$ORCA_STUB_DIR/calls.log"
out=$(resume 2>&1); rc=$?
b=""; [[ "$rc" -eq 1 && "$out" == *'design role has already started'* ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" && b=y
out=$(resume --phase exec 2>&1); rc=$?
c=""; [[ "$rc" -eq 2 ]] && c=y
[[ -n "$a" && -n "$b" && -n "$c" ]] && ok "ST88 再開するものが無ければ止まる" || fail "ST88 (a=$a b=$b c=$c)"
teardown

# ST89: ★ **子に待機の期限を持たせない。**2026-09-23: design が brainstorm でユーザーの回答を
#      待つ間に、reviewer が「1 時間依頼なし」で自分から終了し、レビューが付かなかった。
setup; review_on; start >/dev/null 2>&1
specs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log")
rv=$(head -1 <<<"$specs"); dz=$(tail -1 <<<"$specs"); bad=""
for s in "$rv" "$dz"; do
  for w in 'six times' 'one hour' 'another hour' '24 hours'; do
    [[ "$s" == *"$w"* ]] && bad="$bad [$w]"; done
  [[ "$s" == *'no time limit'* ]] || bad="$bad [no-time-limit]"
done
[[ -z "$bad" ]] && ok "ST89 待機に期限を書かない" || fail "ST89:$bad"; teardown

# ST90: 依頼側は `review-skipped:` を「reviewer が止められた」と読み、レビュー無しで進む。
setup; review_on; start >/dev/null 2>&1
dz=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | tail -1)
[[ "$dz" == *'review-skipped:'* && "$dz" == *'Skip step 7'* ]] \
  && ok "ST90 review-skipped の扱いが載る" || fail "ST90"; teardown

# ST91: 取り込み方は起動時に workers.json へ記録する。省略すれば設定値（既定 merge）
setup; start --integration pr >/dev/null 2>&1
a=$(jq -r '.integration // empty' "$R/.dispatch/s/workers.json" 2>/dev/null); teardown
setup; start >/dev/null 2>&1
b=$(jq -r '.integration // empty' "$R/.dispatch/s/workers.json" 2>/dev/null); teardown
[[ "$a" == pr && "$b" == merge ]] && ok "ST91 取り込み方を記録する" || fail "ST91 (a=$a b=$b)"

# ST92: ★ **続きの起動で取り込み方を変えさせない。**記録と違う値で 2 段目を起こすと、merge と PR が食い違う
setup; phase_b_on; start >/dev/null 2>&1; design_done
exec_phase --integration pr >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 2 && "$(jq -r '.integration' "$R/.dispatch/s/workers.json")" == merge ]] \
  && ok "ST92 続きの起動は取り込み方を受け取らない" || fail "ST92 (rc=$rc)"; teardown

# ST93: 不正な値では何も作らない（設定の解決で止まる）
setup; start --integration squash >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -q 'worktree create\|worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST93 不正な取り込み方で何も作らない" || fail "ST93 (rc=$rc)"; teardown

# ── brainstorm は brainstorming → writing-plans の順（2026-09-23: writing-plans を呼ばず、
#    spec と plan を混ぜた plan.md を 1 本書いて終えた）──
bs_config() {   # $1=phase_b
  mkdir -p "$ORCA_DISPATCH_CONFIG_HOME"
  printf '{"phase_b":"%s","design_mode":"brainstorm"}\n' "$1" > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
}

# ST94: phase_b=on は spec.md と plan.md を status dir に書いて終える。skill の保存先と commit を上書きする
setup; phase_b_on; bs_config on; start >/dev/null 2>&1; sp=$(spec); miss=""
for w in 'superpowers:brainstorming' 'superpowers:writing-plans' "$R/.dispatch/s/spec.md" \
         "$R/.dispatch/s/plan.md" 'not under docs/' 'commit nothing' 'Stop once the plan is written' \
         "apart from $R/.dispatch/s/spec.md"; do
  [[ "$sp" == *"$w"* ]] || miss="$miss [$w]"; done
[[ "$sp" == *'subagent-driven-development'* ]] && miss="$miss [builds]"
[[ -z "$miss" ]] && ok "ST94 brainstorm × phase_b=on は計画まで" || fail "ST94:$miss"; teardown

# ST95: phase_b=off は計画のあと Subagent-driven で実装し、実行方法を尋ねない
setup; bs_config off; start >/dev/null 2>&1; sp=$(spec); miss=""
for w in 'superpowers:writing-plans' 'superpowers:subagent-driven-development' \
         'commit the work on this branch' 'Do not ask how to execute'; do
  [[ "$sp" == *"$w"* ]] || miss="$miss [$w]"; done
[[ -z "$miss" ]] && ok "ST95 brainstorm × phase_b=off は Subagent-driven で作る" || fail "ST95:$miss"; teardown

# ST96: ★ **writing-plans は brainstorm だけ。**direct（--issue の既定）と plan は phase_b=on でも今のまま
bad=""
for m in direct plan; do
  setup; phase_b_on
  printf '{"phase_b":"on","design_mode":"%s"}\n' "$m" > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
  start >/dev/null 2>&1; sp=$(spec)
  [[ "$sp" == *'writing-plans'* || "$sp" == *'spec.md'* ]] && bad="$bad [$m]"
  [[ "$sp" == *'PLAN ONLY'* ]] || bad="$bad [$m:plan-only]"
  teardown
done
[[ -z "$bad" ]] && ok "ST96 direct と plan は writing-plans を呼ばない" || fail "ST96:$bad"

# ST97: exec は spec.md があれば読む。skill は名指ししない
setup; phase_b_on; bs_config on; start >/dev/null 2>&1; design_done
: > "$ORCA_STUB_DIR/calls.log"; exec_phase >/dev/null 2>&1
xs=$(grep 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" | tail -1); miss=""
[[ "$xs" == *"$R/.dispatch/s/spec.md"* ]] || miss="$miss [spec]"
[[ "$xs" == *'superpowers:'* ]] && miss="$miss [skill]"
[[ -z "$miss" ]] && ok "ST97 exec は spec.md を読む" || fail "ST97:$miss"; teardown

# ST98: 共通の STATUS PROTOCOL も「1 回にまとめて尋ねよ」と言わない
setup; start >/dev/null 2>&1
[[ "$(spec)" != *'Ask once'* ]] && ok "ST98 ask を 1 回に縛らない" || fail "ST98"; teardown

# ST99: ★ **phase_b=off の brainstorm は finishing-a-development-branch を走らせない。**Subagent-driven は
#      最後にそれを呼び、merge / PR / 破棄を尋ねる。取り込み方は Step 1b でユーザーが選んでおり、
#      取り込むのは親である。phase_b=on は実装しないので書かない
setup; bs_config off; start >/dev/null 2>&1; sp=$(spec); miss=""
for w in 'Do not run' 'superpowers:finishing-a-development-branch' 'stop after committing; the parent brings the branch home'; do
  [[ "$sp" == *"$w"* ]] || miss="$miss [$w]"; done
teardown
setup; phase_b_on; bs_config on; start >/dev/null 2>&1
[[ "$(spec)" == *'finishing-a-development-branch'* ]] && miss="$miss [phase_b=on]"
[[ -z "$miss" ]] && ok "ST99 brainstorm は取り込みを親に残す" || fail "ST99:$miss"; teardown

echo "---"; echo "failures: $fails"; exit "$fails"
