#!/usr/bin/env bash
# 片付けの判定（Step 5 = `orca-cleanup.ts plan`）と実行（Step 6 = `orca-cleanup.ts run`）。
# 以前は test-docs.sh が SKILL.md の [C1]〜[C7] ブロックを取り出して実行していた（SK6c 系 / SK11 / SK13）。
# **確かめる中身（どの状況で何を提示し、何で止まるか）はそのまま移した。**
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
CLEANUP="$P/bin/orca-cleanup.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }
export ORCA_BIN="$P/test/lib/orca-stub.sh"

# --- stub の世界 -------------------------------------------------------------------------
# Orca の状態は 1 件 1 ファイルで持ち、hook が呼び出しごとに応答を組み立てる。
#   workers/<dispatch>        その worker の releaseState（terminalState も同じ値にする）
#   workers/<dispatch>.reason retainedReason / .fail = release が失敗する
#   workers/<dispatch>.owner  ownershipState（無ければ null）。user_owned = ユーザーが操作した端末
#   workers/<dispatch>.after  release のあとの状態「state [retainedReason]」（無ければ released）。
#                             gone = 一覧から消える / listfail = 次の読み直し 1 回だけ一覧が読めない
#   terminals/<handle>        その端末が居る worktree id（無ければ端末は閉じている）/ .stale = show が rc 0 の ok:false
#   lists/<wt>.stale          terminal list が rc 0 の ok:false
#   worktrees/<wt>.fail       worktree rm が失敗する
#   list-retained.fail / list-all.fail  worker-list（--terminal-state retained 付き / 無し）が rc 7 の ok:false
#   list-all.fail.once        次の worker-list（retained 無し）1 回だけ rc 7 の ok:false
hooks() {
  local d="$ORCA_STUB_DIR"
  cat > "$d/orchestration_worker-list.hook" <<'HOOK'
#!/usr/bin/env bash
d="$ORCA_STUB_DIR"; out="$d/orchestration_worker-list"; filter=""; prev=""
for a in "$@"; do [[ "$prev" == --terminal-state ]] && filter="$a"; prev="$a"; done
once=""; [[ -z "$filter" && -e "$d/list-all.fail.once" ]] && { once=yes; rm -f "$d/list-all.fail.once"; }
if [[ -e "$d/list-${filter:-all}.fail" || -n "$once" ]]; then
  printf '%s\n' '{"ok":false,"error":"unavailable","result":{"workers":[]}}' > "$out"; printf '7\n' > "$out.rc"; exit 0
fi
rm -f "$out.rc"; rows='[]'
for f in "$d"/workers/*; do
  [[ -f "$f" && "$(basename "$f")" != *.* ]] || continue
  st=$(cat "$f"); [[ -z "$filter" || "$st" == "$filter" ]] || continue
  rs=""; [[ -f "$f.reason" ]] && rs=$(cat "$f.reason")
  ow=""; [[ -f "$f.owner" ]] && ow=$(cat "$f.owner")
  rows=$(jq -c --arg id "$(basename "$f")" --arg st "$st" --arg rs "$rs" --arg ow "$ow" \
    '. + [{dispatchId:$id,terminalState:$st,
           resource:{releaseState:$st,retainedReason:(if $rs == "" then null else $rs end),
                     ownershipState:(if $ow == "" then null else $ow end)}}]' <<<"$rows")
done
jq -nc --argjson w "$rows" '{ok:true,result:{workers:$w,counts:{}}}' > "$out"
HOOK
  cat > "$d/terminal_show.hook" <<'HOOK'
#!/usr/bin/env bash
d="$ORCA_STUB_DIR"; out="$d/terminal_show"; h=""; prev=""
for a in "$@"; do [[ "$prev" == --terminal ]] && h="$a"; prev="$a"; done
rm -f "$out.rc"
if [[ -e "$d/terminals/$h.stale" ]]; then
  # 失敗 receipt に古い成功 state が残っている形。ok を見ずに result だけ読むと通ってしまう
  printf '{"ok":false,"error":"stale","result":{"terminal":{"handle":"%s","worktreeId":"%s"}}}\n' \
    "$h" "$(cat "$d/terminals/$h")" > "$out"
elif [[ -f "$d/terminals/$h" ]]; then
  printf '{"ok":true,"result":{"terminal":{"handle":"%s","worktreeId":"%s"}}}\n' "$h" "$(cat "$d/terminals/$h")" > "$out"
else
  printf '%s\n' '{"ok":false,"error":"gone"}' > "$out"; printf '7\n' > "$out.rc"
fi
HOOK
  cat > "$d/terminal_list.hook" <<'HOOK'
#!/usr/bin/env bash
d="$ORCA_STUB_DIR"; out="$d/terminal_list"; w=""; prev=""
for a in "$@"; do [[ "$prev" == --worktree ]] && w="${a#id:}"; prev="$a"; done
rows='[]'
for f in "$d"/terminals/*; do
  [[ -f "$f" && "$f" != *.stale && "$(cat "$f")" == "$w" ]] || continue
  rows=$(jq -c --arg h "$(basename "$f")" '. + [{handle:$h}]' <<<"$rows")
done
if [[ -e "$d/lists/$w.stale" ]]; then
  jq -nc --argjson t "$rows" '{ok:false,error:"stale",result:{terminals:$t}}' > "$out"
else
  jq -nc --argjson t "$rows" '{ok:true,result:{terminals:$t}}' > "$out"
fi
HOOK
  cat > "$d/orchestration_worker-release.hook" <<'HOOK'
#!/usr/bin/env bash
d="$ORCA_STUB_DIR"; out="$d/orchestration_worker-release"; id=""; prev=""
for a in "$@"; do [[ "$prev" == --dispatch ]] && id="$a"; prev="$a"; done
rm -f "$out.rc"
if [[ -e "$d/workers/$id.fail" ]]; then
  printf '%s\n' '{"ok":false,"error":{"code":"release_unknown","message":"stub refused"}}' > "$out"; printf '1\n' > "$out.rc"
  exit 0
fi
# receipt は ok。実測 O43 のように、ok でも何も解放していないことがある（.after で決める）
printf '%s\n' '{"ok":true,"result":{}}' > "$out"
after=released; [[ -f "$d/workers/$id.after" ]] && after=$(cat "$d/workers/$id.after")
case "$after" in
  gone) rm -f "$d/workers/$id" ;;
  listfail) : > "$d/list-all.fail.once" ;;
  *) read -r st rs <<<"$after"; printf '%s\n' "$st" > "$d/workers/$id"
     [[ -z "$rs" ]] || printf '%s\n' "$rs" > "$d/workers/$id.reason" ;;
esac
HOOK
  cat > "$d/worktree_rm.hook" <<'HOOK'
#!/usr/bin/env bash
d="$ORCA_STUB_DIR"; out="$d/worktree_rm"; w=""; prev=""
for a in "$@"; do [[ "$prev" == --worktree ]] && w="${a#id:}"; prev="$a"; done
rm -f "$out.rc"
if [[ -e "$d/worktrees/$w.fail" ]]; then
  printf '%s\n' '{"ok":false,"error":{"code":"worktree_busy","message":"stub refused"}}' > "$out"; printf '1\n' > "$out.rc"
else
  printf '%s\n' '{"ok":true,"result":{}}' > "$out"
fi
if [[ -f "$d/flip-merged" ]]; then
  printf '%s\n' '{"merged":false}' > "$(cat "$d/flip-merged")/integration-result.json"
fi
HOOK
  chmod +x "$d"/*.hook
}

# 1 つの Run の repo と stub を新しく作る
world() {
  T=$(mktemp -d); T=$(cd "$T" && pwd -P)
  REPO="$T/repo"; mkdir -p "$REPO/.dispatch"
  PLAN_FILE="$REPO/.dispatch/cleanup-run_x.json"
  export ORCA_STUB_DIR="$T/orca"; mkdir -p "$ORCA_STUB_DIR"/{workers,terminals,lists,worktrees}
  : > "$ORCA_STUB_DIR/calls.log"; hooks
}
teardown() { rm -rf "$T"; }

# task <slug> [merged] — design 役 1 つのタスク。merged の既定は true
task() {
  local sd="$REPO/.dispatch/$1"; mkdir -p "$sd"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"%s"}\n' "$REPO" > "$sd/run.json"
  printf '%s\n' '{"roles":{}}' > "$sd/workers.json"
  printf '{"merged":%s}\n' "${2:-true}" > "$sd/integration-result.json"
  role "$1" design
}
# role <slug> <role> — 役を 1 つ足す。checkout は clean、端末は生きていて記録どおり、state は retained
role() {
  local sd="$REPO/.dispatch/$1" n="$1-$2" wp="$T/wt/$1-$2"
  mkdir -p "$wp"; git -C "$wp" init -q -b main .; printf 'seed\n' > "$wp/README.md"
  git -C "$wp" add -A; git -C "$wp" -c user.email=t@e -c user.name=t commit -q -m seed
  jq --arg r "$2" --arg h "term_$n" --arg c "ctx_$n" --arg w "wt_$n" --arg p "$wp" \
    '.roles[$r] = {terminal:$h,dispatch:$c,retained:true,worktree_id:$w,worktree_path:$p,
                   worktree_created_by_this_run:true,worktree_terminals:[$h]}' \
    "$sd/workers.json" > "$sd/w" && mv "$sd/w" "$sd/workers.json"
  printf 'retained\n' > "$ORCA_STUB_DIR/workers/ctx_$n"
  printf 'wt_%s\n' "$n" > "$ORCA_STUB_DIR/terminals/term_$n"
}
# workers.json の 1 役を jq で書き換える: edit <slug> '<jq filter>'
edit() { local sd="$REPO/.dispatch/$1"; jq "$2" "$sd/workers.json" > "$sd/w" && mv "$sd/w" "$sd/workers.json"; }
# 計画ファイルは plan が印字した plan_file 行から読む（Step 6 と同じ）。印字が無ければ既定の場所のまま
plan() {
  OUT=$(node "$CLEANUP" plan "$@" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err")
  local printed; printed=$(sed -n 's/^plan_file=//p' <<<"$OUT"); PLAN_FILE="${printed:-$PLAN_FILE}"
}
run() { OUT=$(node "$CLEANUP" run "$@" 2>"$T/err"); RC=$?; ERR=$(cat "$T/err"); }
pj() { jq -c "$1" "$PLAN_FILE" 2>/dev/null; }                  # 計画ファイルへの問い合わせ
mutations() { grep -E 'worker-release|worktree rm' "$ORCA_STUB_DIR/calls.log"; }
sd() { printf '%s' "$REPO/.dispatch/$1"; }

# CL1: 使用法の誤りは exit 2 で、Orca を 1 度も呼ばない
world; task a; bad=""
for args in "" "plan" "plan --bogus" "run" "run --plan $PLAN_FILE" "bogus"; do
  # shellcheck disable=SC2086
  node "$CLEANUP" $args >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [$args]"
done
[[ -z "$bad" && ! -s "$ORCA_STUB_DIR/calls.log" ]] && ok "CL1 使用法の誤りは exit 2" || fail "CL1:$bad"
teardown

# CL2 (旧 SK6c): 記録が読めなければ Run 全体を止め、Orca を呼ばず、計画も書かない
world; d=$(sd bare); mkdir -p "$d"
printf '%s\n' '{}' > "$d/workers.json"; printf '%s\n' '{}' > "$d/integration-result.json"
plan --status-dir "$d"
[[ "$RC" -eq 1 && "$ERR" == *'required cleanup state is missing'* && ! -e "$PLAN_FILE" \
   && ! -s "$ORCA_STUB_DIR/calls.log" ]] && ok "CL2 記録が無ければ何も呼ばずに止まる" || fail "CL2 (rc=$RC err=$ERR)"
teardown

# CL2b (旧 SK13 の前提): workers.json が壊れていても同じ。Run の既知の集合が作れない
world; task a; printf '{' > "$(sd a)/workers.json"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 1 && "$ERR" == *'required cleanup state is missing'* && ! -e "$PLAN_FILE" \
   && ! -s "$ORCA_STUB_DIR/calls.log" ]] && ok "CL2b workers.json が壊れていれば止まる" || fail "CL2b (rc=$RC err=$ERR)"
teardown

# CL3 (旧 SK6k / SK6m / SK13a / SK13d): 1 つの Run に 2 タスク、片方はレビューの 2 役。
#      通常経路では全部を提示し、**Step 5 は release も rm も呼ばない**
world; task a; task b; role b design_review
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
if [[ "$RC" -eq 0 && "$OUT" == *'every retained worker in this Run is one we recorded'* \
   && "$(tail -1 <<<"$OUT")" == "plan_file=$PLAN_FILE" \
   && "$(pj '.tasks[0].offers.terminal[0].argv')" == '["orchestration","worker-release","--dispatch","ctx_a-design","--json"]' \
   && "$(pj '.tasks[0].offers.worktree[0].argv')" == '["worktree","rm","--worktree","id:wt_a-design","--json"]' \
   && "$(pj '.tasks[0].offers.record[0].path')" == "\"$(sd a)\"" \
   && "$(pj '[.tasks[1].offers.terminal[].dispatch]')" == '["ctx_b-design","ctx_b-design_review"]' \
   && "$(pj '[.tasks[1].offers.worktree[].worktree_id]')" == '["wt_b-design","wt_b-design_review"]' \
   && "$(pj '[.tasks[].stopped]')" == '[null,null]' && -z "$(mutations)" ]]; then
  ok "CL3 通常経路は全部を提示し、何も閉じない"
else
  fail "CL3 (rc=$RC out=$OUT err=$ERR)"
fi

# CL4 (旧 SK6m): reviewer の checkout だけ dirty → **その役の worktree だけ**提示しない
printf 'dirt\n' > "$T/wt/b-design_review/dirty.txt"
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
[[ "$RC" -eq 0 && "$(pj '[.tasks[1].offers.worktree[].role]')" == '["design"]' \
   && "$(pj '.tasks[1].kept[] | select(.kind == "worktree") | [.role, .reasons]')" \
      == '["design_review",["the worker checkout has uncommitted changes"]]' \
   && "$OUT" == *'not offering to remove the design_review worktree:'* ]] \
  && ok "CL4 dirty な役の worktree だけ残す" || fail "CL4 (out=$OUT)"
teardown

# CL4b: この dispatch が作っていない worktree は、ほかの条件が揃っても提示しない
world; task a; edit a '.roles.design.worktree_created_by_this_run = false'
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["this dispatch reused an existing worktree; it is not ours to remove"]' ]] \
  && ok "CL4b 再利用 worktree は残す" || fail "CL4b (out=$OUT)"
teardown

# CL4c: checkout を git で読めなければ、clean と決めつけて提示しない
world; task a; mkdir -p "$T/not-a-checkout"; edit a ".roles.design.worktree_path = \"$T/not-a-checkout\""
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["the worker checkout could not be inspected"]' ]] \
  && ok "CL4c 読めない checkout は残す" || fail "CL4c (out=$OUT)"
teardown

# CL5 (旧 SK6d): 記録した端末一覧が null なら「端末 0 件」と取り違えず、削除を提示しない
world; task a; edit a '.roles.design.worktree_terminals = null'
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["the terminals in that worktree could not be listed, so nothing is proven"]' ]] \
  && ok "CL5 inventory=null は unknown" || fail "CL5 (out=$OUT)"
teardown

# CL6 (旧 SK6e): 他の確認が全部通っても、記録に無い端末が worktree に居れば削除を提示しない。
#      読んだのは worker-list / terminal show / terminal list だけで、release を呼んでいない
world; task a; printf 'wt_a-design\n' > "$ORCA_STUB_DIR/terminals/term_foreign"
plan --status-dir "$(sd a)"
if [[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["a terminal in that worktree is not one we recorded"]' ]] \
   && grep -q 'worker-list' "$ORCA_STUB_DIR/calls.log" && grep -q 'terminal show' "$ORCA_STUB_DIR/calls.log" \
   && grep -q 'terminal list' "$ORCA_STUB_DIR/calls.log" && [[ -z "$(mutations)" ]]; then
  ok "CL6 記録に無い端末が居れば worktree を残す"
else
  fail "CL6 (out=$OUT)"
fi
teardown

# CL7 (旧 SK6f): worker-list の失敗 receipt（rc 7・ok:false・古い workers 配列つき）では Run 全体を止める
world; task a; : > "$ORCA_STUB_DIR/list-retained.fail"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 1 && "$ERR" == *'could not list what Orca still holds for this Run; do not remove anything'* \
   && ! -e "$PLAN_FILE" ]] && ok "CL7a retained の一覧が読めなければ止まる" || fail "CL7a (rc=$RC err=$ERR)"
rm -f "$ORCA_STUB_DIR/list-retained.fail"; : > "$ORCA_STUB_DIR/list-all.fail"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 1 && "$ERR" == *'could not read the release state; do not close anything'* \
   && ! -e "$PLAN_FILE" && -z "$(mutations)" ]] && ok "CL7b release state が読めなければ止まる" || fail "CL7b (rc=$RC err=$ERR)"
teardown

# CL8 (旧 SK6f2): receipt は ok でも **この dispatch が Orca の答えに無い**なら、そのタスクだけ止まる
world; task a; task b; rm -f "$ORCA_STUB_DIR/workers/ctx_a-design"
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons')" == '["design: could not read the release state; do not close anything"]' \
   && "$(pj '.tasks[0].offers')" == '{"terminal":[],"worktree":[],"record":[]}' \
   && "$(pj '.tasks[1].offers.terminal | length')" == 1 ]] \
  && ok "CL8 Orca の答えに無い dispatch はそのタスクだけ止める" || fail "CL8 (out=$OUT)"
teardown

# CL8b (旧 [C1] の `*)`): この skill の知らない state は読めないのと同じ。そのタスクだけ止まる
world; task a; printf 'bogus\n' > "$ORCA_STUB_DIR/workers/ctx_a-design"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons')" == '["design: could not read the release state; do not close anything"]' ]] \
  && ok "CL8b 知らない state で止まる" || fail "CL8b (out=$OUT)"
teardown

# CL8c (旧 [C2]/[C3] の欠落検査): 役の記録に端末が無ければ、そのタスクだけ止まる
world; task a; edit a '.roles.design.terminal = null'
plan --status-dir "$(sd a)"
reason=$(pj '.tasks[0].stopped.reasons[0]')
[[ "$RC" -eq 0 && "$reason" == *'required cleanup state is missing'* \
   && "$reason" == *'terminal in workers.json'* && "$reason" == *'worker-show --dispatch ctx_a-design'* \
   && "$reason" == *'result.worker.agentTerminalHandle to roles.design.terminal'* ]] \
  && ok "CL8c 欠けた terminal と Orca からの補い方を示して止まる" || fail "CL8c (out=$OUT)"
teardown

# CL9 (旧 SK6g): release_pending / release_unknown は止まる合図。報告された worker と
#      inspection の argv を残し、何も提示しない
bad=""
for st in release_unknown release_pending; do
  world; task a; printf '%s\n' "$st" > "$ORCA_STUB_DIR/workers/ctx_a-design"
  plan --status-dir "$(sd a)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reported[0].resource.releaseState')" == "\"$st\"" \
     && "$(pj '.tasks[0].stopped.inspect')" == '[["orchestration","worker-show","--dispatch","ctx_a-design","--json"]]' \
     && "$OUT" == *'orchestration worker-show --dispatch ctx_a-design --json'* \
     && "$(pj '.tasks[0].offers')" == '{"terminal":[],"worktree":[],"record":[]}' && -z "$(mutations)" ]] \
    || bad="$bad [$st]"
  teardown
done
[[ -z "$bad" ]] && ok "CL9 release_pending / release_unknown で止まる" || fail "CL9:$bad"

# CL10 (旧 SK6g2): 通常の state は止まる理由ではない
bad=""
for st in retained released already_released active reclaimable not_requested; do
  world; task a; printf '%s\n' "$st" > "$ORCA_STUB_DIR/workers/ctx_a-design"
  plan --status-dir "$(sd a)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped')" == null ]] || bad="$bad [$st]"
  teardown
done
[[ -z "$bad" ]] && ok "CL10 通常の state では止まらない" || fail "CL10:$bad"

# CL11 (旧 SK6f の show): 端末が在るはずの state で show が失敗 receipt なら、そのタスクは止まる
world; task a; : > "$ORCA_STUB_DIR/terminals/term_a-design.stale"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons')" == '["design: could not verify the terminal identity; do not close anything"]' \
   && "$(pj '.tasks[0].offers')" == '{"terminal":[],"worktree":[],"record":[]}' ]] \
  && ok "CL11 identity を確かめられなければ止まる" || fail "CL11 (out=$OUT)"
teardown

# CL12 (旧 SK6f の list): 端末一覧が失敗 receipt なら worktree は提示しない。端末の提示は別の判定なので残る
world; task a; : > "$ORCA_STUB_DIR/lists/wt_a-design.stale"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree')" == '[]' && "$(pj '.tasks[0].offers.terminal | length')" == 1 \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["the terminals in that worktree could not be listed, so nothing is proven"]' ]] \
  && ok "CL12 一覧の失敗 receipt は unknown" || fail "CL12 (out=$OUT)"
teardown

# CL13 (旧 SK6h/i/j): released 系では端末を提示せず、show できないことを identity の証明とする
bad=""
for st in released already_released; do
  world; task a; printf '%s\n' "$st" > "$ORCA_STUB_DIR/workers/ctx_a-design"
  rm -f "$ORCA_STUB_DIR/terminals/term_a-design"
  plan --status-dir "$(sd a)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.terminal')" == '[]' \
     && "$(pj '.tasks[0].kept[] | select(.kind == "terminal") | .reasons')" \
        == '["Orca already closed the design terminal; nothing to close"]' \
     && "$(pj '.tasks[0].offers.worktree[0].argv')" == '["worktree","rm","--worktree","id:wt_a-design","--json"]' ]] \
    || bad="$bad [$st-gone]"
  # 端末がまだ見えて記録と一致するなら、identity は証明され削除も提示される
  printf 'wt_a-design\n' > "$ORCA_STUB_DIR/terminals/term_a-design"
  plan --status-dir "$(sd a)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.worktree | length')" == 1 ]] || bad="$bad [$st-live]"
  teardown
done
[[ -z "$bad" ]] && ok "CL13 released 系は端末を提示せず worktree を提示する" || fail "CL13:$bad"

# CL14 (旧 SK6l): 端末は生きているが記録と違う worktree を報告する → 端末も worktree も提示しない
world; task a; printf 'wt_other\n' > "$ORCA_STUB_DIR/terminals/term_a-design"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.terminal')" == '[]' && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "terminal") | .reasons')" \
      == '["the design terminal no longer matches our state; leave it alone"]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" \
      == '["the terminal identity did not match our state"]' ]] \
  && ok "CL14 identity が合わなければ何も提示しない" || fail "CL14 (out=$OUT)"
teardown

# CL15 (旧 SK11): 記録は merge 済みで、`.dispatch` の直下の本物の status dir のときだけ提示する
world; task a false
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.record')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "record") | .reasons')" \
      == '["the work is not merged yet, so this is the only copy of the request and result"]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "worktree") | .reasons')" == '["the work is not merged yet"]' ]] \
  && ok "CL15a merge 前は記録を残す" || fail "CL15a (out=$OUT)"
teardown
world; task a; mkdir -p "$T/elsewhere"; mv "$(sd a)" "$T/elsewhere/a"
plan --status-dir "$T/elsewhere/a"
[[ "$RC" -eq 0 && "$PLAN_FILE" == "$T/elsewhere/cleanup-run_x.json" && "$(pj '.tasks[0].offers.record')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "record") | .reasons')" \
      == '["the status directory is not inside .dispatch; do not remove it"]' ]] \
  && ok "CL15b .dispatch の外の記録は提示しない" || fail "CL15b (rc=$RC out=$OUT err=$ERR)"
teardown

# CL16 (旧 SK13): [C7] 記録に無い保持中 worker が居れば Run 全体を止める
world; task a; printf 'retained\n' > "$ORCA_STUB_DIR/workers/ctx_ghost"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 1 && "$ERR" == *'Orca still holds retained workers we did not record:'* && "$ERR" == *ctx_ghost* \
   && ! -e "$PLAN_FILE" ]] && ok "CL16a 記録に無い保持で止まる" || fail "CL16a (rc=$RC err=$ERR)"
teardown
# 兄弟を渡し忘れると、その兄弟は ghost に見えて止まる（だから Run の全タスクを渡す）
world; task a; task b
plan --status-dir "$(sd a)"
[[ "$RC" -eq 1 && "$ERR" == *ctx_b-design* ]] && ok "CL16b 渡し忘れた兄弟は ghost に見える" || fail "CL16b (rc=$RC err=$ERR)"
teardown
# 別の Run の dir を混ぜたら、Orca を呼ぶ前に止まる（既知の集合が広がって本物の ghost を隠すため）
world; task a; task b
jq -c '.run_id = "run_y"' "$(sd b)/run.json" > "$T/r" && mv "$T/r" "$(sd b)/run.json"
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
[[ "$RC" -eq 1 && "$ERR" == *"$(sd b) does not belong to Run run_x"* && ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "CL16c 別 Run の dir を混ぜたら止まる" || fail "CL16c (rc=$RC err=$ERR)"
teardown

# CL17: 同じ slug の status dir を 2 つ渡したら使用法の誤り（--approve が区別できない）
world; task a; mkdir -p "$T/other/.dispatch"; cp -R "$(sd a)" "$T/other/.dispatch/a"
plan --status-dir "$(sd a)" --status-dir "$T/other/.dispatch/a"
[[ "$RC" -eq 2 && ! -s "$ORCA_STUB_DIR/calls.log" ]] && ok "CL17 slug の重複は使用法の誤り" || fail "CL17 (rc=$RC)"
teardown

# --- run（Step 6）----------------------------------------------------------------------
# CL18: 承認されたものを slug 順に、タスク内は 端末 → worktree → 記録 の順で実行する
#       計画のタスク順（--status-dir の順）が slug 順でなくても、実行は slug 順になる
world; task a; task b
plan --status-dir "$(sd b)" --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve b:record --approve b:worktree --approve b:terminal \
    --approve a:terminal --approve a:worktree --approve a:record
expected="orchestration worker-release --dispatch ctx_a-design --json
worktree rm --worktree id:wt_a-design --json
orchestration worker-release --dispatch ctx_b-design --json
worktree rm --worktree id:wt_b-design --json"
[[ "$RC" -eq 0 && "$(mutations | sed 's/ $//')" == "$expected" && ! -e "$(sd a)" && ! -e "$(sd b)" \
   && "$OUT" == *'removed: design terminal'* && "$OUT" == *"removed: dispatch record $(sd a)"* ]] \
  && ok "CL18 slug 順・端末 → worktree → 記録" || fail "CL18 (rc=$RC out=$OUT calls=$(mutations))"
teardown

# CL19: 承認されなかったものは実行せず、残したと報告する
world; task a
plan --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve a:terminal
[[ "$RC" -eq 0 && "$(mutations | sed 's/ $//')" == 'orchestration worker-release --dispatch ctx_a-design --json' \
   && -d "$(sd a)" && "$OUT" == *'kept: design worktree id:wt_a-design (not approved)'* ]] \
  && ok "CL19 承認されていないものは残す" || fail "CL19 (out=$OUT)"
teardown

# CL20: 失敗はそのタスクの依存する手順（その役の worktree と記録）を止めるが、他のタスクには影響しない
world; task a; task b; : > "$ORCA_STUB_DIR/workers/ctx_a-design.fail"
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record \
    --approve b:terminal --approve b:worktree --approve b:record
[[ "$RC" -eq 1 && -d "$(sd a)" && ! -e "$(sd b)" \
   && "$(mutations | grep -c 'id:wt_a-design')" -eq 0 && "$(mutations | grep -c 'id:wt_b-design')" -eq 1 \
   && "$OUT" == *'failed: design terminal: rc=1; release_unknown; stub refused'* \
   && "$OUT" == *'not run: design worktree id:wt_a-design (the design terminal step failed)'* ]] \
  && ok "CL20 失敗はそのタスクだけを止める" || fail "CL20 (rc=$RC out=$OUT)"
teardown

# CL21: release が ok でも Orca が端末を保持したまま（user_takeover）なら「閉じた」と言わない。
#       失敗ではないので worktree の段へは進む
world; task a; printf 'retained user_takeover\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.after"
plan --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree
[[ "$RC" -eq 0 && "$OUT" == *'Orca kept it (releaseState: retained, retainedReason: user_takeover); it was not closed'* \
   && "$OUT" != *'removed: design terminal'* && "$(mutations | grep -c 'worktree rm --worktree id:wt_a-design')" -eq 1 ]] \
  && ok "CL21 保持された端末を閉じたと言わない" || fail "CL21 (out=$OUT)"
teardown

# CL21b: 読み直して閉じたと確かめられなければ、release が ok でもそのタスクの失敗。後続（worktree・記録）は
#        実行せず、ほかのタスクは進む。user_takeover 以外の理由で保持されたときも同じ（spec 4-2 の例外は
#        user_takeover だけ）。一覧が読めない・その worker が一覧から消えた、も確かめられないのと同じ
bad=""
for after in release_pending release_unknown active 'retained no_owned_resource' gone listfail; do
  world; task a; task b; printf '%s\n' "$after" > "$ORCA_STUB_DIR/workers/ctx_a-design.after"
  plan --status-dir "$(sd a)" --status-dir "$(sd b)"
  run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record \
      --approve b:terminal --approve b:worktree --approve b:record
  [[ "$RC" -eq 1 && -d "$(sd a)" && ! -e "$(sd b)" \
     && "$(mutations | grep -c 'id:wt_a-design')" -eq 0 && "$(mutations | grep -c 'id:wt_b-design')" -eq 1 \
     && "$OUT" == *'failed: design terminal: '* && "$OUT" == *'removed: design terminal'* \
     && "$OUT" == *'not run: design worktree id:wt_a-design (the design terminal step failed)'* ]] \
    || bad="$bad [$after]"
  teardown
done
[[ -z "$bad" ]] && ok "CL21b 閉じたと確かめられない release はそのタスクの失敗" || fail "CL21b:$bad"

# CL22: worktree の削除が失敗したら、記録は消さない
world; task a; : > "$ORCA_STUB_DIR/worktrees/wt_a-design.fail"
plan --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve a:worktree --approve a:record
[[ "$RC" -eq 1 && -d "$(sd a)" && "$OUT" == *'failed: design worktree id:wt_a-design'* \
   && "$OUT" == *"not run: dispatch record $(sd a)"* ]] && ok "CL22 失敗のあとは記録を消さない" || fail "CL22 (out=$OUT)"
teardown

# CL23: 計画に無い操作の承認は使用法の誤り。何も実行しない
world; task a; task b false
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
bad=""
for approval in a:bogus zzz:terminal b:record a terminal:; do
  run --plan "$PLAN_FILE" --approve a:terminal --approve "$approval"
  [[ "$RC" -eq 2 ]] || bad="$bad [$approval]"
done
[[ -z "$bad" && -z "$(mutations)" && -d "$(sd a)" ]] && ok "CL23 提示されていない承認では何も実行しない" || fail "CL23:$bad"
teardown

# CL24: plan 後に .dispatch が外部へ移されたら、記録を消す直前の場所の検査で止める
world; task a
plan --status-dir "$(sd a)"
cp "$PLAN_FILE" "$T/plan.json"
mv "$REPO/.dispatch" "$T/elsewhere"
ln -s "$T/elsewhere" "$REPO/.dispatch"
run --plan "$T/plan.json" --approve a:record
[[ "$RC" -eq 1 && -d "$T/elsewhere/a" && "$OUT" == *'the status directory is not inside .dispatch; do not remove it'* ]] \
  && ok "CL24 .dispatch の外は消さない" || fail "CL24 (rc=$RC out=$OUT)"
teardown

# CL24b: plan と run の間だけでなく、worktree の操作後に merge 状態が変わっても記録を消さない
world; task a
plan --status-dir "$(sd a)"
printf '%s\n' "$(sd a)" > "$ORCA_STUB_DIR/flip-merged"
run --plan "$PLAN_FILE" --approve a:worktree --approve a:record
[[ "$RC" -eq 1 && -d "$(sd a)" && "$OUT" == *'failed: dispatch record'* \
   && "$OUT" == *'the work is not merged yet'* && "$(mutations | grep -c 'worktree rm')" -eq 1 ]] \
  && ok "CL24b 削除直前に merge 状態を読み直す" || fail "CL24b (rc=$RC out=$OUT)"
teardown

# CL25: 計画の argv を書き換えたら（--force の追加）、計画ごと拒んで何も実行しない
world; task a
plan --status-dir "$(sd a)"
jq '.tasks[0].offers.worktree[0].argv += ["--force"]' "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:worktree
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -z "$(mutations)" ]] \
  && ok "CL25 書き換えた argv は実行しない" || fail "CL25 (rc=$RC err=$ERR)"
teardown

# CL25b: terminal 側の argv も同じ形の検査を受ける
world; task a
plan --status-dir "$(sd a)"
jq '.tasks[0].offers.terminal[0].argv += ["--force"]' "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:terminal
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -z "$(mutations)" ]] \
  && ok "CL25b 書き換えた terminal argv は実行しない" || fail "CL25b (rc=$RC err=$ERR)"
teardown

# CL25c: 別タスクの記録へ path を向けても、承認されたタスクの記録として消せない
world; task a; task b false
plan --status-dir "$(sd a)" --status-dir "$(sd b)"
jq --arg p "$(sd b)" '.tasks[0].offers.record[0].path = $p' "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:record
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -d "$(sd a)" && -d "$(sd b)" \
   && -z "$(mutations)" ]] \
  && ok "CL25c 別タスクへの記録の付け替えを拒む" || fail "CL25c (rc=$RC err=$ERR)"
teardown

# CL25d: 未 merge のタスクへ記録 offer を足しても消せない
world; task a false
plan --status-dir "$(sd a)"
jq --arg p "$(sd a)" '.tasks[0].offers.record = [{path:$p}]' "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:record
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -d "$(sd a)" && -z "$(mutations)" ]] \
  && ok "CL25d 未 merge の記録 offer を拒む" || fail "CL25d (rc=$RC err=$ERR)"
teardown

# CL25e: dispatch と argv を揃えて変えても、その役の記録に無い端末は release しない
world; task a
plan --status-dir "$(sd a)"
jq '.tasks[0].offers.terminal[0].dispatch = "ctx_other" | .tasks[0].offers.terminal[0].argv[3] = "ctx_other"' \
  "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:terminal
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -z "$(mutations)" ]] \
  && ok "CL25e 別 dispatch への付け替えを拒む" || fail "CL25e (rc=$RC err=$ERR)"
teardown

# CL25f: 止まったタスクに offer を後から足しても実行しない
world; task a; printf 'release_unknown\n' > "$ORCA_STUB_DIR/workers/ctx_a-design"
plan --status-dir "$(sd a)"
jq '.tasks[0].offers.worktree = [{role:"design",worktree_id:"wt_a-design",argv:["worktree","rm","--worktree","id:wt_a-design","--json"]}]' \
  "$PLAN_FILE" > "$T/p" && mv "$T/p" "$PLAN_FILE"
run --plan "$PLAN_FILE" --approve a:worktree
[[ "$RC" -eq 1 && "$ERR" == *'could not read the cleanup plan'* && -d "$(sd a)" && -z "$(mutations)" ]] \
  && ok "CL25f 停止したタスクへの offer 追加を拒む" || fail "CL25f (rc=$RC err=$ERR)"
teardown

# CL27: ★ **置き換えた試行は「記録に無い保持」ではない。**orca-recover が --retry-of で置き換えた dispatch は
#       `superseded` に残る。Orca がそれを retained のまま持っていても、Run 全体を止めない
#       （2026-09-23 の P1 の dispatch: 手で workers.json から外した exec が [C7] を止めた）。
#       ★ ただし**その端末と理由を示し、記録は提示しない** — 記録を消すと、次の [C7] がそれを ghost と読む
world; task a; printf 'retained\n' > "$ORCA_STUB_DIR/workers/ctx_old"
plan --status-dir "$(sd a)"; before=$RC
edit a '.roles.design.superseded = ["ctx_old"]'
plan --status-dir "$(sd a)"
[[ "$before" -eq 1 && "$RC" -eq 0 && "$(pj '.tasks[0].stopped')" == null \
   && "$(pj '.tasks[0].offers.record | length')" == 0 \
   && "$(pj '.tasks[0].offers.terminal | length')" == 1 && "$(pj '.tasks[0].offers.worktree | length')" == 1 \
   && "$(pj '[.tasks[0].kept[] | select(.kind == "terminal") | .reasons[0]] | first')" == *'replaced attempt ctx_old (releaseState: retained)'* \
   && "$(pj '[.tasks[0].kept[] | select(.kind == "record") | .reasons[]] | join(" ")')" == *'replaced attempt'* ]] \
  && ok "CL27 置き換えた試行は [C7] を止めず、保持されている間は記録を残す" || fail "CL27 (before=$before rc=$RC out=$OUT)"
teardown

# CL28: ★ **置き換えた試行の release が確定していなければ、そのタスクは何も閉じない・消さない**（[C1] と同じ）。
#       新しい試行が正常でも同じ。inspection の argv を載せる。Run のほかのタスクは続ける
bad=""
for st in release_pending release_unknown; do
  world; task a; task b; printf '%s\n' "$st" > "$ORCA_STUB_DIR/workers/ctx_old"
  edit a '.roles.design.superseded = ["ctx_old"]'
  plan --status-dir "$(sd a)" --status-dir "$(sd b)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons[0]')" == *"replaced attempt ctx_old is $st"* \
     && "$(pj '.tasks[0].stopped.inspect[0]')" == '["orchestration","worker-show","--dispatch","ctx_old","--json"]' \
     && "$(pj '.tasks[0].offers | [.terminal, .worktree, .record] | map(length) | add')" == 0 \
     && "$(pj '.tasks[1].stopped')" == null ]] || bad="$bad [$st]"
  teardown
done
[[ -z "$bad" ]] && ok "CL28 置き換えた試行の release が確定していなければタスクを止める" || fail "CL28:$bad"

# CL29: 置き換えた試行を Orca が一覧に載せていない・知らない state を返すときも、確かめられないので止める
bad=""
world; task a; edit a '.roles.design.superseded = ["ctx_gone"]'
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons[0]')" == *'replaced attempt ctx_gone'* ]] || bad="$bad [unlisted]"
teardown
world; task a; printf 'weird\n' > "$ORCA_STUB_DIR/workers/ctx_old"; edit a '.roles.design.superseded = ["ctx_old"]'
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons[0]')" == *'replaced attempt ctx_old'* ]] || bad="$bad [unknown-state]"
teardown
[[ -z "$bad" ]] && ok "CL29 置き換えた試行が確かめられなければ止める" || fail "CL29:$bad"

# CL30: 置き換えた試行を Orca が閉じ終えていれば、いつもどおり記録も提示する
world; task a; printf 'released\n' > "$ORCA_STUB_DIR/workers/ctx_old"; edit a '.roles.design.superseded = ["ctx_old"]'
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped')" == null && "$(pj '.tasks[0].offers.record | length')" == 1 \
   && "$(pj '[.tasks[0].kept[] | select(.kind == "terminal")] | length')" == 0 ]] \
  && ok "CL30 閉じ終えた置き換え元は記録の提示を止めない" || fail "CL30 (rc=$RC out=$OUT)"
teardown
# CL31: ★ **ユーザーが操作した端末（ownershipState: user_owned）には release を提示しない。**Orca はそれを閉じず、
#       retainedReason は Step 3 の user_requested のままのことがある（2026-09-24、influencer-platform と P2 / P3 の design）。
#       理由を示して残し、worktree と記録は今までどおりの条件で提示する。同じタスクのほかの役はそのまま提示する
world; task a; role a design_review
printf 'user_requested\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.reason"
printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped')" == null \
   && "$(pj '[.tasks[0].offers.terminal[].role]')" == '["design_review"]' \
   && "$(pj '[.tasks[0].offers.worktree[].role]')" == '["design","design_review"]' \
   && "$(pj '.tasks[0].offers.record | length')" == 1 \
   && "$(pj '.tasks[0].kept[] | select(.kind == "terminal") | [.role, .reasons]')" \
      == '["design",["the user owns the design terminal (ownershipState: user_owned), so Orca will not release it; removing the design worktree closes it"]]' \
   && "$OUT" == *'keep terminal (design): the user owns the design terminal (ownershipState: user_owned)'* \
   && -z "$(mutations)" ]] \
  && ok "CL31 ユーザー所有の端末は release を提示せず、worktree は提示する" || fail "CL31 (rc=$RC out=$OUT)"
teardown

# CL32: 所有の判定は [C1] と identity の判定を追い越さない。release が未確定ならタスクは止まり、
#       端末が記録と合わなければ「記録と合わない」として端末も worktree も提示しない
bad=""
for st in release_pending release_unknown; do
  world; task a; printf '%s\n' "$st" > "$ORCA_STUB_DIR/workers/ctx_a-design"
  printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
  plan --status-dir "$(sd a)"
  [[ "$RC" -eq 0 && "$(pj '.tasks[0].stopped.reasons[0]')" == *"the worker is $st"* \
     && "$(pj '.tasks[0].offers | [.terminal, .worktree, .record] | map(length) | add')" == 0 ]] || bad="$bad [$st]"
  teardown
done
world; task a; printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
printf 'wt_other\n' > "$ORCA_STUB_DIR/terminals/term_a-design"
plan --status-dir "$(sd a)"
[[ "$RC" -eq 0 && "$(pj '.tasks[0].offers.terminal')" == '[]' && "$(pj '.tasks[0].offers.worktree')" == '[]' \
   && "$(pj '.tasks[0].kept[] | select(.kind == "terminal") | .reasons')" \
      == '["the design terminal no longer matches our state; leave it alone"]' ]] || bad="$bad [identity]"
teardown
[[ -z "$bad" ]] && ok "CL32 所有の判定は [C1] と identity を追い越さない" || fail "CL32:$bad"


# CL33: ★ **報告された不具合（2026-09-24、influencer-platform の run_da468ac5993f）。**Step 5 のあとでユーザーが design の
#       端末を操作し、worker-release は ok を返しながら何も閉じなかった（retained / user_owned / user_requested）。旧版は
#       user_takeover 以外の保持を失敗にして、同じタスクの残り 3 本の端末と 4 つの worktree を 1 つも実行しなかった。
#       保持として報告し、失敗にせず、残りを全部実行する。修正前の版が書いた計画で run したときも同じ経路を通る
world; task a; role a design_review; role a exec; role a exec_review
plan --status-dir "$(sd a)"
printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
printf 'retained user_requested\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.after"
run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record
[[ "$RC" -eq 0 && ! -e "$(sd a)" \
   && "$(mutations | grep -c 'worker-release')" -eq 4 && "$(mutations | grep -c 'worktree rm')" -eq 4 \
   && "$OUT" == *'kept: design terminal: the user owns it (ownershipState: user_owned, releaseState: retained, retainedReason: user_requested), so Orca did not close it; removing its worktree closes it'* \
   && "$OUT" != *'removed: design terminal'* && "$OUT" != *'failed:'* && "$OUT" != *'not run:'* \
   && "$OUT" == *'removed: exec_review terminal'* && "$OUT" == *'removed: design worktree id:wt_a-design'* ]] \
  && ok "CL33 Step 5 のあとユーザーが操作した端末は保持として報告し、残りを実行する" || fail "CL33 (rc=$RC out=$OUT)"
teardown

# CL33b: 所有は未確定の release を覆さない。読み直しが release_pending / release_unknown なら、user_owned でも
#        その役の失敗（[C1] と同じく、Orca が確定させていない release の上に worktree の削除を積まない）
bad=""
for after in release_pending release_unknown; do
  world; task a; plan --status-dir "$(sd a)"
  printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
  printf '%s\n' "$after" > "$ORCA_STUB_DIR/workers/ctx_a-design.after"
  run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record
  [[ "$RC" -eq 1 && -d "$(sd a)" && "$(mutations | grep -c 'worktree rm')" -eq 0 \
     && "$OUT" == *"failed: design terminal: the release was accepted, but its state reads '$after'"* ]] || bad="$bad [$after]"
  teardown
done
[[ -z "$bad" ]] && ok "CL33b 所有は未確定の release を覆さない" || fail "CL33b:$bad"
# CL34: ★ **失敗が止めるのは、それに依存する手順だけ。**design の端末の解放が失敗しても（receipt の失敗でも、
#       ok のあとに閉じたと確かめられない保持でも）、ほかの役の端末と worktree は実行する。止めるのは design の
#       worktree とタスクの記録（最後の手順）。ほかのタスクは影響を受けない（2026-09-24: 旧版は残り 3 本の端末と
#       4 つの worktree を 1 つも実行しなかった）
bad=""
for how in fail 'retained no_owned_resource'; do
  world; task a; role a design_review; role a exec; task b
  if [[ "$how" == fail ]]; then : > "$ORCA_STUB_DIR/workers/ctx_a-design.fail"
  else printf '%s\n' "$how" > "$ORCA_STUB_DIR/workers/ctx_a-design.after"; fi
  plan --status-dir "$(sd a)" --status-dir "$(sd b)"
  run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record \
      --approve b:terminal --approve b:worktree --approve b:record
  [[ "$RC" -eq 1 && -d "$(sd a)" && ! -e "$(sd b)" \
     && "$(mutations | grep -c 'worker-release --dispatch ctx_a-')" -eq 3 \
     && "$(mutations | grep -cE 'id:wt_a-design( |$)')" -eq 0 \
     && "$(mutations | grep -cE 'id:wt_a-design_review( |$)')" -eq 1 \
     && "$(mutations | grep -cE 'id:wt_a-exec( |$)')" -eq 1 \
     && "$OUT" == *'failed: design terminal: '* \
     && "$OUT" == *'removed: design_review terminal'* && "$OUT" == *'removed: exec terminal'* \
     && "$OUT" == *'not run: design worktree id:wt_a-design (the design terminal step failed)'* \
     && "$OUT" == *"not run: dispatch record $(sd a) (an earlier step for this task failed)"* ]] \
    || bad="$bad [$how]"
  teardown
done
[[ -z "$bad" ]] && ok "CL34 端末の失敗はその役の worktree と記録だけを止める" || fail "CL34:$bad"

# CL35: worktree の削除の失敗も同じ。止めるのはタスクの記録だけで、ほかの役の worktree は実行する
world; task a; role a design_review; : > "$ORCA_STUB_DIR/worktrees/wt_a-design.fail"
plan --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record
[[ "$RC" -eq 1 && -d "$(sd a)" && "$(mutations | grep -c 'worker-release')" -eq 2 \
   && "$(mutations | grep -cE 'id:wt_a-design_review( |$)')" -eq 1 \
   && "$OUT" == *'failed: design worktree id:wt_a-design'* \
   && "$OUT" == *'removed: design_review worktree id:wt_a-design_review'* \
   && "$OUT" == *"not run: dispatch record $(sd a) (an earlier step for this task failed)"* ]] \
  && ok "CL35 worktree の失敗は記録だけを止める" || fail "CL35 (rc=$RC out=$OUT)"
teardown
# CL36: ★ **直したあとの流れ全体。**Step 5 の時点で design がユーザー所有なら release は提示されず、run は design に
#       worker-release を打たずに、残り 3 本の端末・4 つの worktree・記録を片付ける（2026-09-24 の Run と同じ 4 役）
world; task a; role a design_review; role a exec; role a exec_review
printf 'user_requested\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.reason"
printf 'user_owned\n' > "$ORCA_STUB_DIR/workers/ctx_a-design.owner"
plan --status-dir "$(sd a)"
run --plan "$PLAN_FILE" --approve a:terminal --approve a:worktree --approve a:record
[[ "$RC" -eq 0 && ! -e "$(sd a)" \
   && "$(mutations | grep -cE 'worker-release --dispatch ctx_a-design( |$)')" -eq 0 \
   && "$(mutations | grep -c 'worker-release')" -eq 3 && "$(mutations | grep -c 'worktree rm')" -eq 4 \
   && "$OUT" == *'kept: design terminal: the user owns the design terminal (ownershipState: user_owned)'* ]] \
  && ok "CL36 ユーザー所有の端末には release を打たず、残りを片付ける" || fail "CL36 (rc=$RC out=$OUT)"
teardown
# CL26: zsh から呼んでも同じ結果になる（設計 3-5。呼び出し側のシェルに依存しない）
if command -v zsh >/dev/null 2>&1; then
  world; task a; task b; role b design_review
  plan --status-dir "$(sd a)" --status-dir "$(sd b)"; bash_rc=$RC; bash_out=$OUT; bash_plan=$(cat "$PLAN_FILE")
  zsh_out=$(zsh -c 'node "$1" plan --status-dir "$2" --status-dir "$3"' zsh "$CLEANUP" "$(sd a)" "$(sd b)" 2>/dev/null)
  zsh_rc=$?
  [[ "$zsh_rc" -eq "$bash_rc" && "$zsh_out" == "$bash_out" && "$(cat "$PLAN_FILE")" == "$bash_plan" ]] \
    && ok "CL26 zsh から呼んでも同じ結果" || fail "CL26 (bash=$bash_rc zsh=$zsh_rc)"
  teardown
else
  echo "SKIP: CL26 zsh が無い"
fi

echo "---"; echo "failures: $fails"; exit "$fails"
