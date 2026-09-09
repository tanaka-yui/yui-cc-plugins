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
reuse_fixture() { printf '{"ok":true,"result":{"worktrees":[{"id":"wt_old","name":"s","path":"%s","branch":"refs/heads/orca/s"}]}}\n' \
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
for n in 'ORCA_BIN' 'worker_done' '--task-id' '--dispatch-id' '--dispatch-capability' \
         '--from' '--outcome' 'report-status.sh' 'dispatch-show --task'; do
  [[ "$l" == *"$n"* ]] || miss="$miss [$n]"; done
[[ "$l" == *' orca orchestration'* ]] && miss="$miss [bare-orca]"
[[ -z "$miss" ]] && ok "ST4 依頼と lifecycle argv" || fail "ST4 欠落:$miss"; teardown

# ST4b: **ask / escalation を使わせない。**Stage 1 の親はそれを処理できない
setup; start >/dev/null 2>&1; l=$(spec)
[[ "$l" == *'do not send'* || "$l" == *'Do not send'* ]] && [[ "$l" == *escalation* ]] \
  && ok "ST4b ask/escalation を禁じる" || fail "ST4b 禁止が書かれていない"; teardown

# ST5: Run の束縛先が自分でなければ起動しない (O26)。workers.json が identity を持つ。
#      worker-start は --agent を渡し --model は渡さない。**--setup skip を渡す**
setup; echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_o"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"; start >/dev/null 2>&1
grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" && fail "ST5 無関係な Run で起動した"; teardown
setup; start >/dev/null 2>&1
jq -e '.run_id=="run_x" and .worktree_id=="wt_1" and .branch=="orca/s"
       and .integration_branch=="main"
       and .roles.design.terminal=="term_w" and .roles.design.task=="task_x" and .roles.design.dispatch=="ctx_x"' \
  "$R/.dispatch/s/workers.json" >/dev/null 2>&1 || fail "ST5 workers.json"
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
wc_=$(grep 'worktree create' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$ws" == *--agent* && "$ws" != *--model* && "$wc_" == *'--setup skip'* ]] \
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
setup; printf '{"ok":true,"result":{"worktrees":[{"id":"a","name":"s","path":"%s","branch":"refs/heads/orca/s"},{"id":"b","name":"s","path":"/tmp/other","branch":"refs/heads/x"}]}}\n' \
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
setup; out=$(ORCA_FAIL_WRITE_AT=workers-initial start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && [[ "$out" == *"worktree=wt_1"* && "$out" == *"terminal=none"* ]] \
  && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9 identity を出して自分の分だけ戻す" || fail "ST9 (rc=$rc out=$out)"; teardown

# ST9b: **Task 成立後の write 失敗は KEPT。**この境界では何も消してはならない。
#       failpoint は呼び出し地点 ID で撃つ — basename 比較では Task 前と区別できない
setup; out=$(ORCA_FAIL_WRITE_AT=workers-after-task start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] \
  && [[ "$out" == *"task=task_x"* && "$out" == *KEPT* ]] \
  && grep -q 'orchestration task-create' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9b Task 成立後は KEPT で何も消さない" || fail "ST9b (rc=$rc out=$out)"; teardown

# ST9a: task-create が task id を返したなら、rc 非 0 でも Task の不在を断定せず、何も削除しない。
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_task-create.rc"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"task-create failed (rc=1) but returned task id task_x"* \
  && "$out" == *"Resources are KEPT"* && "$out" == *"task=task_x"* ]] \
  && ! grep -q 'terminal close\|worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9a task id 付きの task-create 失敗は KEPT" || fail "ST9a (rc=$rc out=$out)"; teardown

# ST9a2: rc 0 で task id が無い receipt は Task 不在を証明しない。何も cleanup しない。
setup; echo '{"ok":true,"result":{"task":{}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"task-create returned success but no task id"* && "$out" == *KEPT* \
  && "$out" == *"worktree=wt_1"* && "$out" == *"terminal=none"* \
  && "$out" == *"task-list --run run_x"* ]] \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9a2 曖昧な task-create は KEPT" || fail "ST9a2 (rc=$rc out=$out)"; teardown

# ST9b2: **Dispatch 成立後の write 失敗も同じ**
setup; out=$(ORCA_FAIL_WRITE_AT=workers-after-dispatch start 2>&1); rc=$?
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
jq -e '.worktree_created_by_this_run == true
       and (.worktree_terminals | length == 2)' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14 作成 worktree と端末集合" || fail "ST14 ($(jq -c . "$R/.dispatch/s/workers.json"))"; teardown
setup; reuse_fixture; start >/dev/null 2>&1
jq -e '.worktree_created_by_this_run == false' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14b 再利用は owned=false" || fail "ST14b 再利用を owned にした"; teardown

# ST14c: **terminal list に失敗したら空配列ではなく null を記録する** (round 4 finding 1)。
#        [] にすると、あとの cleanup gate が「未 account 0」と読んで削除を許す
setup; echo 1 > "$ORCA_STUB_DIR/terminal_list.rc"; start >/dev/null 2>&1
jq -e '.worktree_terminals == null' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
  && ok "ST14c inventory 失敗は null" \
  || fail "ST14c ($(jq -c '.worktree_terminals' "$R/.dispatch/s/workers.json"))"; teardown

# ST14d: schema が配列でないときも null
setup; echo '{"ok":true,"result":{"terminals":"nope"}}' > "$ORCA_STUB_DIR/terminal_list"
start >/dev/null 2>&1
jq -e '.worktree_terminals == null' "$R/.dispatch/s/workers.json" >/dev/null 2>&1 \
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
got=$(jq -r '.worktree_path // empty' "$R/.dispatch/s/workers.json" 2>/dev/null)
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
got=$(jq -r '.worktree_path // empty' "$R/.dispatch/s/workers.json" 2>/dev/null)
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

# ST31: ★ **設定ゼロの挙動を変えない。**`--model` を省けば Orca 側の既定が使われる。
#       ここで既定を捏造すると、設定していない利用者の dispatch が黙って変わる
setup; start >/dev/null 2>&1
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$ws" == *'--agent claude'* && "$ws" != *'--model'* && "$ws" != *'--effort'* ]] \
  && ok "ST31 設定ゼロなら model/effort を渡さない" || fail "ST31 [$ws]"; teardown

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
echo '{"roles":{"design":{"agent":"claude","model":"sonnet"}}}' > "$ORCA_DISPATCH_CONFIG_HOME/config.json"
start >/dev/null 2>&1
d=$(jq -c '.roles.design | {agent,model,effort:(has("effort"))}' "$R/.dispatch/s/workers.json" 2>/dev/null)
[[ "$d" == '{"agent":"claude","model":"sonnet","effort":false}' ]] \
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

echo "---"; echo "failures: $fails"; exit "$fails"
