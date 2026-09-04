#!/usr/bin/env bash
# worker の起動。**他人の資源を触らない**ことと、**成功していないのに成功を返さない**こと。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"
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
  echo '{"ok":true,"result":{"terminal":{"handle":"term_w"}}}' > "$ORCA_STUB_DIR/terminal_create"
  echo '{"ok":true,"result":{"task":{"id":"task_x"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
}
teardown() { git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
             rm -rf "$ORCA_STUB_DIR" "$R" "$REQ" "$(dirname "$WT")"
             unset ORCA_TERMINAL_HANDLE ORCA_BIN; }
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
#      --terminal と --model を併用しない (O5)。**--setup skip を渡す**
setup; echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_o"}}}' \
  > "$ORCA_STUB_DIR/orchestration_run-current"; start >/dev/null 2>&1
grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" && fail "ST5 無関係な Run で起動した"; teardown
setup; start >/dev/null 2>&1
jq -e '.run_id=="run_x" and .worktree_id=="wt_1" and .branch=="orca/s"
       and .integration_branch=="main"
       and .design.terminal=="term_w" and .design.task=="task_x" and .design.dispatch=="ctx_x"' \
  "$R/.dispatch/s/workers.json" >/dev/null 2>&1 || fail "ST5 workers.json"
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
wc_=$(grep 'worktree create' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$ws" == *--terminal* && "$ws" != *--model* && "$wc_" == *'--setup skip'* ]] \
  && ok "ST5 束縛・identity・O5・setup skip" || fail "ST5 (ws=$ws wc=$wc_)"; teardown

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
[[ $? -eq 1 ]] && ! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6e dirty な再利用を拒否" || fail "ST6e dirty を渡した"; teardown

# ST6f: **rc 非 0 なのに receipt らしき JSON を返す create を成功にしない**
setup; echo 1 > "$ORCA_STUB_DIR/worktree_create.rc"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6f create の rc を見る" || fail "ST6f rc を無視した"; teardown
setup; echo 1 > "$ORCA_STUB_DIR/terminal_create.rc"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'task-create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6g terminal create の rc を見る" || fail "ST6g rc を無視した"; teardown

# ST6h: rc 0 なのに handle が無い terminal create は、cleanup identity と rc を隠さない。
setup; echo '{"ok":true,"result":{"terminal":{}}}' > "$ORCA_STUB_DIR/terminal_create"
echo 8 > "$ORCA_STUB_DIR/worktree_rm.rc"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"worktree=wt_1"* && "$out" == *"terminal=none"* \
  && "$out" == *"no terminal handle was returned, so no terminal close was attempted"* \
  && "$out" == *"worktree rm FAILED (rc=8); it is KEPT"* ]] \
  && ! grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6h terminal create の不完全 receipt も identity と cleanup rc を報告" \
  || fail "ST6h (rc=$rc out=$out)"; teardown

# ST6b: 同名が複数返ったら曖昧として止まる（勝手に 1 件目を選ばない）
setup; printf '{"ok":true,"result":{"worktrees":[{"id":"a","name":"s","path":"%s","branch":"refs/heads/orca/s"},{"id":"b","name":"s","path":"/tmp/other","branch":"refs/heads/x"}]}}\n' \
  "$WT" > "$ORCA_STUB_DIR/worktree_list"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'terminal create' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST6b 曖昧なら止まる" || fail "ST6b 1 件目を勝手に選んだ"; teardown

# ST7: 端末作成に失敗したら **自分が作った worktree だけ**を戻す。再利用分は消さない
setup; echo 1 > "$ORCA_STUB_DIR/terminal_create.rc"; echo '{"ok":false}' > "$ORCA_STUB_DIR/terminal_create"
start >/dev/null 2>&1
grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" || fail "ST7 rollback しない"; teardown
setup; reuse_fixture
echo 1 > "$ORCA_STUB_DIR/terminal_create.rc"; echo '{"ok":false}' > "$ORCA_STUB_DIR/terminal_create"
start >/dev/null 2>&1
! grep -q 'worktree create' "$ORCA_STUB_DIR/calls.log" \
  && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST7 自分の分だけ戻し、再利用分は消さない" || fail "ST7 再利用 / 保持が壊れている"; teardown

# ST8: **worker-start は rc 0 + state=ready + dispatch id の 3 つ揃いを要求する。**
#      failed の receipt に dispatchId が残っていても成功にしない
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_x"}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8 failed receipt を成功にせず削除もしない" || fail "ST8 failed を成功にした"; teardown
setup; echo '{"ok":true,"result":{"state":"outcome_unknown","dispatchId":"ctx_x"}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"; start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8b outcome_unknown も同じ" || fail "ST8b unknown を成功にした"; teardown
setup; echo '{"ok":true,"result":{"state":"ready"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
start >/dev/null 2>&1
[[ $? -eq 1 ]] && ! grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST8c ready でも dispatch id が無ければ KEPT" || fail "ST8c dispatch id 欠落を成功にした"; teardown

# ST9: **Task 未作成の段の write 失敗 → identity を出し、自分が作った分だけ戻す**
setup; out=$(ORCA_FAIL_WRITE_AT=workers-initial start 2>&1); rc=$?
[[ "$rc" -eq 1 ]] && [[ "$out" == *"worktree=wt_1"* && "$out" == *"terminal=term_w"* ]] \
  && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" \
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

# ST9a: task-create failure も同じ cleanup guarantee。identity と各 cleanup の結果を出す。
setup; echo 1 > "$ORCA_STUB_DIR/orchestration_task-create.rc"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"worktree=wt_1"* && "$out" == *"terminal=term_w"* \
  && "$out" == *"the terminal was closed"* && "$out" == *"worktree this call created was removed"* ]] \
  && grep -q 'terminal close' "$ORCA_STUB_DIR/calls.log" && grep -q 'worktree rm' "$ORCA_STUB_DIR/calls.log" \
  && ok "ST9a task-create 失敗も identity と truthful cleanup" || fail "ST9a (rc=$rc out=$out)"; teardown

# ST9a2: rc 0 で task id が無い receipt は Task 不在を証明しない。何も cleanup しない。
setup; echo '{"ok":true,"result":{"task":{}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
out=$(start 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"task-create returned success but no task id"* && "$out" == *KEPT* \
  && "$out" == *"worktree=wt_1"* && "$out" == *"terminal=term_w"* \
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

# ST11: **runner を worker checkout の外に置く。**中に置くと checkout が dirty になり、
#       worker の成果 commit に混ざるか、後の worktree rm で消える
setup; start >/dev/null 2>&1
[[ ! -e "$WT/.orca-run-design.sh" ]] && [[ -x "$R/.dispatch/s/run-design.sh" ]] \
  && [[ -z "$(git -C "$WT" status --porcelain)" ]] \
  && ok "ST11 runner は checkout の外" || fail "ST11 worker checkout を汚した"; teardown

# ST12: terminal create には runner の absolute path を渡す
setup; start >/dev/null 2>&1
grep 'terminal create' "$ORCA_STUB_DIR/calls.log" | grep -q "$R/.dispatch/s/run-design.sh" \
  && ok "ST12 absolute path を渡す" || fail "ST12 相対パスを渡した"; teardown

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

# ST15: **repo root に空白があっても壊れない。**
#       `--command` の中で runner path が引用されていること、そして
#       **生成された runner を実際に実行できること**を見る。
#       旧実装（`--command "bash $RUNNER"`）ではここが落ちる
setup_space() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  export ORCA_TERMINAL_HANDLE=term_p
  BASE=$(mktemp -d); R="$BASE/repo with space"; mkdir -p "$R"
  git -C "$R" init -q -b main .; echo seed > "$R/README.md"; git -C "$R" add -A
  git -C "$R" -c user.email=t@e -c user.name=t commit -q -m seed
  WT="$BASE/wt with space"; git -C "$R" worktree add -q -b orca/s "$WT" >/dev/null 2>&1
  REQ=$(mktemp); MARK="MARK-$$"; printf 'do %s\n' "$MARK" > "$REQ"
  echo '{"ok":true,"result":{"runtime":{"reachable":true}}}' > "$ORCA_STUB_DIR/status"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_p"}}}' > "$ORCA_STUB_DIR/terminal_show"
  echo '{"ok":true,"result":{"run":{"id":"run_x"}}}' > "$ORCA_STUB_DIR/orchestration_run-create"
  echo '{"ok":true,"result":{"run":{"id":"run_x","coordinator_handle":"term_p"}}}' \
    > "$ORCA_STUB_DIR/orchestration_run-current"
  echo '{"ok":true,"result":{"worktrees":[]}}' > "$ORCA_STUB_DIR/worktree_list"
  printf '{"ok":true,"result":{"worktree":{"id":"wt_1","path":"%s","branch":"refs/heads/orca/s"}}}\n' \
    "$WT" > "$ORCA_STUB_DIR/worktree_create"
  echo '{"ok":true,"result":{"terminal":{"handle":"term_w"}}}' > "$ORCA_STUB_DIR/terminal_create"
  echo '{"ok":true,"result":{"terminals":[{"handle":"term_w"}]}}' > "$ORCA_STUB_DIR/terminal_list"
  echo '{"ok":true,"result":{"task":{"id":"task_x"}}}' > "$ORCA_STUB_DIR/orchestration_task-create"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_x"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
}
teardown_space() { git -C "$R" worktree remove --force "$WT" >/dev/null 2>&1
                   rm -rf "$ORCA_STUB_DIR" "$BASE" "$REQ"; unset ORCA_TERMINAL_HANDLE ORCA_BIN; }
setup_space
bash "$P/bin/orca-start.sh" --request-file "$REQ" --slug s --objective obj --repo-root "$R" >/dev/null 2>&1
RUNNER="$R/.dispatch/s/run-design.sh"
# ★ **本当の判別はここ**: Orca は --command を「シェル文字列」として解釈する。
#   その文字列を語分割したとき **ちょうど 2 語**（bash と path）でなければ、
#   空白入り path で worker は起動しない。旧形 `--command "bash $RUNNER"` は 3 語以上になる。
#   値そのものは argv.log（生の 0x1f 区切り）から取る — calls.log は %q 済みで取り出せない
# preflight の `terminal show` も同じ log に居るので、**create の行だけ**を取る
CMD=$(grep 'terminal.create' "$ORCA_STUB_DIR/argv.log" | head -1 \
      | tr '\037' '\n' | awk 'p{print; exit} /^--command$/{p=1}')
WORDS=$(bash -c 'set -- '"$CMD"'; echo $#' 2>/dev/null || echo 99)
if [[ -x "$RUNNER" ]] && bash -n "$RUNNER" && [[ "$WORDS" == 2 ]] \
   && sed 's|^exec claude.*|exec true|' "$RUNNER" > "$RUNNER.t" && bash "$RUNNER.t"; then
  ok "ST15 空白入り path で command が 2 語、runner も実行できる"
else
  fail "ST15 空白入り path で壊れた (words=$WORDS cmd=[$CMD])"
fi
teardown_space

# ST13: 既存 slug は上書きしない
setup; mkdir -p "$R/.dispatch/s"; echo x > "$R/.dispatch/s/keep"; start >/dev/null 2>&1
[[ $? -ne 0 && -f "$R/.dispatch/s/keep" ]] && ok "ST13 既存 slug を拒否" || fail "ST13 上書きした"; teardown

echo "---"; echo "failures: $fails"; exit "$fails"
