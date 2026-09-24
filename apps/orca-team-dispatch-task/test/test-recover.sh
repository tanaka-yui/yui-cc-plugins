#!/usr/bin/env bash
# owner の回復（spec 10-1 の表 / F-e）。**確認できないものに replacement を作らないこと**が
# 全部である。旧 capability と新 capability が同時に lifecycle を進めてはならない。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
R="$P/bin/orca-recover.ts"
CMP="$P/skills/orca-team-dispatch-task/scripts/completion.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"; : > "$ORCA_STUB_DIR/argv.log"
  SD=$(mktemp -d); mkdir -p "$SD/roles/design"
  printf '{"run_id":"run_x","parent_handle":"term_p","repo_root":"/tmp"}\n' > "$SD/run.json"
  jq -nc '{integration_role:"design",roles:{design:{task:"task_x",dispatch:"ctx_old",
    worktree_id:"wt_1",agent:"claude",model:"sonnet",effort:"low",generation:1}}}' \
    > "$SD/workers.json"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_new","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_new"}]}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-start"
  echo '{"ok":true,"result":{"message":{"id":"m1"}}}' > "$ORCA_STUB_DIR/orchestration_send"
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_BIN ORCA_STUB_DIR; }
show() {   # $1=worker state  $2=dispatch status
  jq -nc --arg s "$1" --arg d "${2:-dispatched}" \
    '{ok:true,result:{worker:{state:$s},dispatch:{status:$d}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-show"
}
owe() { node "$CMP" --role-dir "$SD/roles/design" prepare >/dev/null; }
rec() { node "$R" --status-dir "$SD" "$@"; }
gen() { jq -r '.roles.design.generation' "$SD/workers.json"; }
did_() { jq -r '.roles.design.dispatch' "$SD/workers.json"; }

# RC1: ★ **生きているなら nudge するだけ。**replacement を作ると、旧 capability と
#      新 capability が同時に lifecycle を進めうる。
setup; owe; show active
rec >/dev/null 2>&1
[[ "$(grep -c 'orchestration send' "$ORCA_STUB_DIR/calls.log")" -eq 1 ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(did_)" == ctx_old && "$(gen)" -eq 1 ]] \
  && ok "RC1 生きているなら nudge だけ" || fail "RC1"
teardown

# RC2: ★ **失われたことが証明されたら replacement。**`task-create` は走らせない —
#      Task は既に在る。generation を上げ、旧試行の完了記録は捨てる。
setup; owe; show failed
rec >/dev/null 2>&1
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ -n "$ws" ]] && [[ "$ws" == *'--retry-of ctx_old'* ]] && [[ "$ws" == *'--task task_x'* ]] \
  && ! grep -q 'task-create' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(did_)" == ctx_new && "$(gen)" -eq 2 ]] \
  && [[ ! -f "$SD/roles/design/completion.json" ]] \
  && ok "RC2 failed なら retry-of で置き換え generation を上げる" || fail "RC2 [$ws]"
teardown

# RC3: ★ **確認できないものに replacement を作らない**（O19）。fence が先である。
setup; owe; show outcome_unknown
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -ne 0 ]] && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(did_)" == ctx_old && "$(gen)" -eq 1 ]] \
  && ok "RC3 outcome_unknown では置き換えない" || fail "RC3 (rc=$rc)"
teardown

# RC4: ★ **Orca 側が既に terminal なら送らない。**ローカルを合わせて終わる。
setup; owe; show failed completed
rec >/dev/null 2>&1
[[ "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == settled ]] \
  && ! grep -qE 'worker-start|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC4 Orca が terminal ならローカルを合わせて終わる" || fail "RC4"
teardown

# RC5: ★ **replacement は新しい nonce で offer し直す。**旧 generation の accepted は
#      照合で落ちる（CM3 と同じ理由）。
setup; owe
old_nonce=$(node "$CMP" --role-dir "$SD/roles/design" nonce)
show failed; rec >/dev/null 2>&1
new_nonce=$(node "$CMP" --role-dir "$SD/roles/design" prepare)
[[ -n "$old_nonce" && -n "$new_nonce" && "$old_nonce" != "$new_nonce" ]] \
  && ok "RC5 置き換え後は新しい nonce になる" || fail "RC5 ($old_nonce/$new_nonce)"
teardown

# RC6: ★ **まだ何も託していない役は回復しない。**offer も失敗の意図も無いなら、
#      送るべきものが無い。
setup; show failed
rec >/dev/null 2>&1
! grep -qE 'worker-start|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC6 送るべきものが無ければ何もしない" || fail "RC6"
teardown

# RC7: 失敗の意図（status.json = error）だけでも回復の対象である。
#      成功系と同じく、送れる誰かが要る。
setup; echo '{"status":"error"}' > "$SD/roles/design/status.json"; show failed
rec >/dev/null 2>&1
grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC7 失敗の意図も owner を回復する" || fail "RC7"
teardown

# RC8: settled 済みは触らない（完了している）。
setup; owe
node "$CMP" --role-dir "$SD/roles/design" sent
n=$(node "$CMP" --role-dir "$SD/roles/design" nonce)
node "$CMP" --role-dir "$SD/roles/design" accept --nonce "$n"
node "$CMP" --role-dir "$SD/roles/design" settle
show failed; rec >/dev/null 2>&1
! grep -qE 'worker-start|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC8 settled は触らない" || fail "RC8"
teardown

# RC9: worker-show が読めなければ何も決めない（推測しない）。
setup; owe
printf '{"ok":false,"error":"nope"}\n' > "$ORCA_STUB_DIR/orchestration_worker-show"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -ne 0 ]] && ! grep -qE 'worker-start|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC9 状態が読めなければ何も決めない" || fail "RC9 (rc=$rc)"
teardown

# RC10: --dry-run は判断だけを出して何もしない。
setup; owe; show failed
out=$(rec --dry-run 2>/dev/null)
[[ "$out" == *'design: replace'* ]] \
  && ! grep -qE 'worker-start|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC10 --dry-run は何もしない" || fail "RC10 ($out)"
teardown

# RC11: ★ **nudge も届くだけでは起こせない。**`orchestration send` の nudge が効かなかった
#       のが 2026-09-10 の停止の一因である。生きている worker には端末も叩く。
setup; owe; show idle
echo '{"ok":true,"result":{}}' > "$ORCA_STUB_DIR/terminal_send"
upd=$(jq -c '.roles.design.terminal = "term_old"' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
rec >/dev/null 2>&1
a=$(tr '\037' '\n' < "$ORCA_STUB_DIR/argv.log")
grep -q 'completion-nudge' <<<"$a" && grep -qxF 'term_old' <<<"$a" \
  && ok "RC11 nudge のあとに端末を起こす" || fail "RC11"
teardown

# RC12: 起こせなくても nudge そのものの結末は変わらない。
setup; owe; show idle
echo '{"ok":false,"error":{"message":"gone"}}' > "$ORCA_STUB_DIR/terminal_send"
upd=$(jq -c '.roles.design.terminal = "term_old"' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ok "RC12 起床の失敗は nudge を覆さない" || fail "RC12 (rc=$rc)"
teardown

# ── 待機の生死 ────────────────────────────────────────────────────────────
# ★ **worker が生きているのに何も進まない最有力の原因は「誰も待っていない」である。**
#   待機は 24 時間常駐するのでホスト側の都合で外から止められる（実測 2026-09-11、2 回連続:
#   worker が同じマシンでテストを並列に回し、ハーネスがメモリ逼迫で待機を停止した）。
#   そのとき要るのは replacement ではなく待機の起動し直しなので、**先に言う**。

# RC13: 鼓動が無ければ「誰も待っていない」と言う。**判断は変えない。**
setup; owe; show active
out=$(rec --dry-run 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *"no wait has stamped this status dir"* && "$out" == *"design: nudge"* ]] \
  && ok "RC13 鼓動が無ければ待機の不在を言う" || fail "RC13 (rc=$rc out=$out)"
teardown

# RC14: 鼓動が古ければ、沈黙した秒数を名指しする。
setup; owe; show active
jq -nc --argjson b "$(( $(date +%s) - 4000 ))" '{pid:1,beat:$b,window_ms:300000}' > "$SD/wait.json"
out=$(rec --dry-run 2>&1)
[[ "$out" == *"no wait has answered for"* && "$out" == *"design: nudge"* ]] \
  && ok "RC14 古い鼓動は沈黙の長さを言う" || fail "RC14 (out=$out)"
teardown

# RC15: 新しい鼓動なら黙る。**正常な回復を警告で汚さない。**
setup; owe; show active
jq -nc --argjson b "$(date +%s)" '{pid:1,beat:$b,window_ms:300000}' > "$SD/wait.json"
out=$(rec --dry-run 2>&1)
[[ "$out" != *"no wait has"* && "$out" == *"design: nudge"* ]] \
  && ok "RC15 生きている待機には触れない" || fail "RC15 (out=$out)"
teardown

# RC16: ★ **ユーザーが止めた役を生き返らせない。**置き換えると、止めた役が別の端末で走り出す
setup; owe; show failed
echo '{"stopped_at":1,"by":"user"}' > "$SD/roles/design/stopped.json"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 0 && "$out" == *"stopped by the user"* ]] \
  && ! grep -q 'worker-start\|orchestration send' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC16 止めた役は回復しない" || fail "RC16 (rc=$rc out=$out)"
teardown

# ── 起動が終わらなかった役（TS 移行 spec 5 章。2026-09-23 の P1 の dispatch で見つかった）────
# ★ worker-start が ready を返さなかった役は、dispatch が記録され、Orca が返したときは端末も記録される。
#   status は `starting` のまま残る。`orca-start --phase exec` は「もう dispatch がある」と
#   断り、完了を負っていないので回復の対象にもならず、**やり直す口が無かった。**
failed_start() {   # 起動が終わらなかった design（端末の記録なし・status は starting）
  echo '{"status":"starting"}' > "$SD/roles/design/status.json"
  echo '{"ok":true,"result":{"terminals":[{"handle":"term_old"},{"handle":"term_new"}]}}' \
    > "$ORCA_STUB_DIR/terminal_list"
}

# RC17: ★ **失敗が証明された起動は、同じ Task に --retry-of で置き換える。**先に失敗した試行の端末を
#       worker-release で閉じ（手で閉じると user_takeover で残る）、置き換えた dispatch は superseded に残す
setup; failed_start; show failed failed
rec >/dev/null 2>&1; rc=$?
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
rl=$(grep -n 'worker-release' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
sl=$(grep -n 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
[[ "$rc" -eq 0 && "$ws" == *'--retry-of ctx_old'* && "$ws" == *'--task task_x'* && "$ws" == *'--worktree id:wt_1'* \
   && -n "$rl" && "$rl" -lt "$sl" ]] \
  && grep 'worker-release' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--dispatch ctx_old' \
  && ! grep -q 'task-create' "$ORCA_STUB_DIR/calls.log" \
  && jq -e '.roles.design | .dispatch == "ctx_new" and .terminal == "term_new" and .generation == 2
            and .superseded == ["ctx_old"] and .worktree_terminals == ["term_old","term_new"]' \
       "$SD/workers.json" >/dev/null \
  && ok "RC17 起動が終わらなかった役を retry-of で置き換える" || fail "RC17 (rc=$rc ws=$ws)"
teardown

# RC18: ★ **失敗が証明されていなければ置き換えない。**起動中・outcome_unknown は見るだけ
setup; failed_start; show ready
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"its start did not complete"* && "$out" == *"worker-show --dispatch ctx_old"* ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC18 失敗が証明されない起動は置き換えない" || fail "RC18 (rc=$rc out=$out)"
teardown

# RC19: --dry-run は判断だけを出す
setup; failed_start; show failed failed
out=$(rec --dry-run 2>/dev/null); rc=$?
[[ "$rc" -eq 0 && "$out" == *'design: replace the failed start'* ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC19 --dry-run は起動のやり直しも実行しない" || fail "RC19 (rc=$rc out=$out)"
teardown

# RC20: 失敗した試行の端末を閉じられなくても、置き換えは止めない（superseded として記録に残る）
setup; failed_start; show failed failed
printf '%s\n' '{"ok":false,"error":{"code":"release_unknown","message":"stub"}}' > "$ORCA_STUB_DIR/orchestration_worker-release"
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-release.rc"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 0 && "$(did_)" == ctx_new && "$out" == *'could not release the terminal of the failed start'* ]] \
  && jq -e '.roles.design.superseded == ["ctx_old"]' "$SD/workers.json" >/dev/null \
  && ok "RC20 release の失敗は置き換えを止めない" || fail "RC20 (rc=$rc out=$out)"
teardown

# RC21: 完了を負った役の置き換え（RC2 の経路）も、置き換えた dispatch と端末の inventory を記録する。
#       記録しないと、旧 dispatch が retained のままなら [C7] が止まり、新しい端末は [C3] が「記録に無い」と読む
setup; owe; show failed
echo '{"ok":true,"result":{"terminals":[{"handle":"term_new"}]}}' > "$ORCA_STUB_DIR/terminal_list"
rec >/dev/null 2>&1
jq -e '.roles.design | .superseded == ["ctx_old"] and .worktree_terminals == ["term_new"]' "$SD/workers.json" >/dev/null \
  && ! grep -q 'worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC21 置き換えは superseded と端末の inventory を残す" || fail "RC21 ($(jq -c .roles.design "$SD/workers.json"))"
teardown

# RC22: status が `starting` でない役（status.json の無い役を含む）は「起動が終わらなかった」と読まない
#       （RC6 と同じく、何も託していない役は回復しない）
setup; show failed failed
rec >/dev/null 2>&1
! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC22 status の無い役は起動のやり直しにしない" || fail "RC22"
teardown

# RC23: ★ **置き換えが ready にならなくても、発行された dispatch は捨てない。**記録しないと次の回復は
#       古い dispatch を --retry-of に渡し直し、新しい試行は誰にも追われない（orca-start の orphan と同じ）。
#       Orca が端末を返せば ready でなくても記録する。**置き換えた試行の完了の記録は残さない** — 新しい worker を起こす前に退避し、
#       記録できたら消す。ready を報告しない試行も動いていることがあり、残すと前の試行の nonce と受理を引き継ぐ
#       （round 1・2 のレビュー F1。RC40〜RC43）
setup; owe; show failed
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'ctx_retry'* && ! -e "$SD/roles/design/completion.json" ]] \
  && jq -e '.roles.design | .dispatch == "ctx_retry" and .terminal == "" and .generation == 2
            and .superseded == ["ctx_old"] and .start_incomplete == true' "$SD/workers.json" >/dev/null \
  && ok "RC23 ready にならない置き換えも dispatch を記録する" || fail "RC23 (rc=$rc out=$out)"
teardown

# RC24: outcome_unknown で dispatch が返った置き換えも同じ（確認できないまま捨てない）
setup; failed_start; show failed failed
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"outcome_unknown","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(did_)" == ctx_retry ]] \
  && jq -e '.roles.design.superseded == ["ctx_old"] and .roles.design.terminal == ""' "$SD/workers.json" >/dev/null \
  && ok "RC24 outcome_unknown の置き換えも dispatch を記録する" || fail "RC24 (rc=$rc)"
teardown

# RC25: ★ **次の回復は最新の試行を見る。**RC24 のあと、その試行が failed と証明されたら、--retry-of には
#       最新の dispatch を渡し、superseded は古い順に積む
setup; failed_start; show failed failed
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
rec >/dev/null 2>&1
rm -f "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_new","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_new"}]}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-start"
: > "$ORCA_STUB_DIR/calls.log"
rec >/dev/null 2>&1; rc=$?
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && "$ws" == *'--retry-of ctx_retry'* ]] \
  && grep 'worker-release' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--dispatch ctx_retry' \
  && jq -e '.roles.design | .dispatch == "ctx_new" and .terminal == "term_new" and .generation == 3
            and .superseded == ["ctx_old","ctx_retry"] and (has("start_incomplete") | not)' "$SD/workers.json" >/dev/null \
  && ok "RC25 次の回復は最新の試行を置き換える" || fail "RC25 (rc=$rc ws=$ws)"
teardown

# ── 完了を負う役の置き換えが ready にならなかったあと（round 2 のレビューで見つかった経路）──────────
# ★ 役の status（done / error）と古い completion は前の試行が残したもので、最新の試行が起きたかは言わない。
#   status だけで「起動が終わらなかった」を判定すると、次の回復は ctx_retry の failed を「Orca が決着させた」と
#   読み、古い completion を settled にして終わる（以後ずっと already settled locally）。
owed_accepted() {   # 成果を報告済み（status done / completion accepted）で、worker_done を送れずに失われた design
  owe; n=$(node "$CMP" --role-dir "$SD/roles/design" nonce)
  node "$CMP" --role-dir "$SD/roles/design" sent; node "$CMP" --role-dir "$SD/roles/design" accept --nonce "$n"
  echo '{"status":"done"}' > "$SD/roles/design/status.json"
}
retry_fails() {     # 次の worker-start は failed で ctx_retry を返す
  echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
  echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
}
retry_succeeds() {
  rm -f "$ORCA_STUB_DIR/orchestration_worker-start.rc"
  echo '{"ok":true,"result":{"state":"ready","dispatchId":"ctx_new","effects":[{"kind":"terminal","role":"agent","action":"created","id":"term_new"}]}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-start"
}

# RC26: ★ **次の回復は、古い completion を settled にせず、最新の試行（ctx_retry）を確かめて置き換える。**
#       ctx_retry の worker-show が failed / failed でも「Orca が決着させた」とは読まない
setup; owed_accepted; show failed; retry_fails
rec >/dev/null 2>&1; first=$?
show failed failed; retry_succeeds; : > "$ORCA_STUB_DIR/calls.log"
out=$(rec 2>&1); second=$?
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$first" -eq 1 && "$second" -eq 0 && "$ws" == *'--retry-of ctx_retry'* && "$out" != *'reconciled locally'* ]] \
  && grep 'worker-release' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--dispatch ctx_retry' \
  && [[ ! -f "$SD/roles/design/completion.json" ]] \
  && jq -e '.roles.design | .dispatch == "ctx_new" and .superseded == ["ctx_old","ctx_retry"]
            and (has("start_incomplete") | not)' "$SD/workers.json" >/dev/null \
  && ok "RC26 完了を負う役でも、次の回復は最新の試行を置き換える" || fail "RC26 ($first/$second ws=$ws out=$out)"
teardown

# RC27: 最新の試行が outcome_unknown の間は置き換えず、記録（ctx_retry と印）もそのまま残す。前の試行の完了の記録は
#       置き換えの前に退避して消してあり、settled に化けることもない
setup; owed_accepted; show failed; retry_fails
rec >/dev/null 2>&1
show outcome_unknown; : > "$ORCA_STUB_DIR/calls.log"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'its start did not complete'* ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && [[ -z "$(node "$CMP" --role-dir "$SD/roles/design" phase)" ]] \
  && jq -e '.roles.design | .dispatch == "ctx_retry" and .start_incomplete == true' "$SD/workers.json" >/dev/null \
  && ok "RC27 最新の試行が確認できない間は何もしない" || fail "RC27 (rc=$rc out=$out)"
teardown

# ── Orca が start_unknown と言う起動（2026-09-24、influencer-platform）──────────────────────────────
# ★ Orca は依頼を入力したが agent のターン開始を観測できなかった。生死のどちらの証拠でもない（動いている reviewer にも、
#   シェルへ戻って死んだ exec にも出た）。以前は「not replacing anything」で何もせず、スキルの手順では先へ進めなかった。
#   引数なしでは画面と 2 つの手段を見せて止まり、選ぶのはユーザー（--adopt / --restart）
screen() {   # terminal read --screen の応答。引数が画面の行
  jq -nc '{ok:true,result:{terminal:{source:"screen",tail:$ARGS.positional}}}' --args "$@" > "$ORCA_STUB_DIR/terminal_read"
}
unconfirmed() {   # $1 = worker-show が出す端末（'' なら出さない）。起動が終わらなかった design を Orca が start_unknown と言う
  failed_start
  upd=$(jq -c '.roles.design.start_incomplete = true' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
  jq -nc --arg t "${1-term_u}" '{ok:true,result:{worker:({state:"start_unknown",stage:"turn_start_unobserved"}
      + (if $t == "" then {} else {agentTerminalHandle:$t} end)),dispatch:{status:"pending"},
      terminal:{preview:"preview-line"}}}' > "$ORCA_STUB_DIR/orchestration_worker-show"
  screen 'codex is reviewing' 'waiting for a review request' '' ''
}
stops_after() {   # worker-stop のあと、Orca は $1 と言う
  printf '#!/usr/bin/env bash\necho %q > "$ORCA_STUB_DIR/orchestration_worker-show"\n' \
    "{\"ok\":true,\"result\":{\"worker\":{\"state\":\"$1\"},\"dispatch\":{\"status\":\"failed\"}}}" \
    > "$ORCA_STUB_DIR/orchestration_worker-stop.hook"
  chmod +x "$ORCA_STUB_DIR/orchestration_worker-stop.hook"
}
acted() { grep -E 'worker-start|worker-stop|worker-release|orchestration send' "$ORCA_STUB_DIR/calls.log"; }

# RC28: ★ **引数なしでは、画面の最後の数行と 2 つの手段を見せて止まる。**勝手に置き換えも記録もしない
setup; unconfirmed; before=$(jq -c . "$SD/workers.json")
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *"'start_unknown'"* && "$out" == *'  | waiting for a review request'* \
   && "$out" == *'--role design --adopt'* && "$out" == *'--role design --restart'* && -z "$(acted)" \
   && "$(jq -c . "$SD/workers.json")" == "$before" ]] \
  && grep 'terminal read' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--terminal term_u' \
  && ok "RC28 start_unknown は画面と 2 つの手段を見せて止まる" || fail "RC28 (rc=$rc out=$out)"
teardown

# RC28b: --dry-run でも同じものを見せ、判断の行（stdout）は出さない
setup; unconfirmed
so=$(rec --dry-run 2>/dev/null); rc=$?; se=$(rec --dry-run 2>&1 >/dev/null)
[[ "$rc" -eq 1 && -z "$so" && "$se" == *'--role design --adopt'* && -z "$(acted)" ]] \
  && ok "RC28b --dry-run でも画面と手段を見せるだけ" || fail "RC28b (rc=$rc so=$so)"
teardown

# RC29: 見せるのは画面の最後の数行だけ（末尾の空行は落とす）。画面が読めなければ worker-show の preview に落とす
setup; unconfirmed; screen $(seq -f 'row-%g' 1 40) '' ''
a=$(rec 2>&1)
teardown
setup; unconfirmed
printf '%s\n' '{"ok":false,"error":{"code":"terminal_not_found"}}' > "$ORCA_STUB_DIR/terminal_read"
echo 1 > "$ORCA_STUB_DIR/terminal_read.rc"
b=$(rec 2>&1); rc=$?
[[ "$a" == *'  | row-40'* && "$a" == *'  | row-26'* && "$a" != *'  | row-25'* \
   && "$rc" -eq 1 && "$b" == *'  | preview-line'* && "$b" == *'--adopt'* ]] \
  && ok "RC29 画面の最後の数行だけを見せ、読めなければ preview" || fail "RC29 (a=$a b=$b)"
teardown

# RC30: ★ **--adopt は端末を記録して start_incomplete を外し、端末の inventory を取り直す。**同じ試行を続けるので
#       dispatch・generation・完了の記録には触らず、何も起こさない。以後は「起動が終わらなかった役」ではない
setup; unconfirmed; owe
out=$(rec --role design --adopt 2>&1); rc=$?
next=$(rec 2>&1); rc2=$?
[[ "$rc" -eq 0 && "$out" == *'adopted dispatch ctx_old'* && -z "$(acted)" && -f "$SD/roles/design/completion.json" \
   && "$rc2" -eq 1 && "$next" != *'its start did not complete'* ]] \
  && jq -e '.roles.design | .dispatch == "ctx_old" and .terminal == "term_u" and .generation == 1
            and (has("start_incomplete") | not) and (has("superseded") | not)
            and .worktree_terminals == ["term_old","term_new"]' "$SD/workers.json" >/dev/null \
  && ok "RC30 --adopt は端末を記録し印を外す" || fail "RC30 (rc=$rc rc2=$rc2 out=$out next=$next)"
teardown

# RC30b: 待機がすでに端末を埋めていても、--adopt は印を外す（Review Focus 1）
setup; unconfirmed
upd=$(jq -c '.roles.design.terminal = "term_u"' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
rec --role design --adopt >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && jq -e '.roles.design | .terminal == "term_u" and (has("start_incomplete") | not)' \
  "$SD/workers.json" >/dev/null \
  && ok "RC30b 待機が埋めた端末があっても引き受けられる" || fail "RC30b (rc=$rc)"
teardown

# RC31: --adopt が効かないものは、何も変えずに 1。起動が完了した役・失敗が証明された起動・端末の出ない起動
setup; show start_unknown
upd=$(jq -c '.roles.design.terminal = "term_old"' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
before=$(jq -c . "$SD/workers.json"); ea=$(rec --role design --adopt 2>&1); a=$?
[[ "$(jq -c . "$SD/workers.json")" == "$before" ]] || a=99; teardown
setup; failed_start; show failed failed
before=$(jq -c . "$SD/workers.json"); rec --role design --adopt >/dev/null 2>&1; b=$?
[[ "$(jq -c . "$SD/workers.json")" == "$before" && -z "$(acted)" ]] || b=99; teardown
setup; unconfirmed ''
before=$(jq -c . "$SD/workers.json"); ec=$(rec --role design --adopt 2>&1); c=$?
[[ "$(jq -c . "$SD/workers.json")" == "$before" ]] || c=99
[[ "$a" -eq 1 && "$ea" == *'does not apply'* && "$b" -eq 1 && "$c" -eq 1 && "$ec" == *'names no terminal'* ]] \
  && ok "RC31 --adopt が効かないものは何も変えない" || fail "RC31 ($a/$b/$c ea=$ea ec=$ec)"
teardown

# RC32: 使用法。--adopt / --restart は --role で 1 役を名指しし、同時には渡せない。記録に無い役は 1
setup; unconfirmed
rec --adopt >/dev/null 2>&1; a=$?
rec --role design --adopt --restart >/dev/null 2>&1; b=$?
rec --role nope --restart >/dev/null 2>&1; c=$?
[[ "$a" -eq 2 && "$b" -eq 2 && "$c" -eq 1 && -z "$(acted)" ]] \
  && ok "RC32 --adopt / --restart の使用法" || fail "RC32 ($a/$b/$c)"
teardown

# RC33: ★ **--restart は先に worker-stop で fence し、Orca が stopped と言ってから置き換える。**止めずに置き換えると、
#       生きていた場合に 2 つの capability が 1 つの lifecycle を進める。stopped.json は書かない（ユーザーの停止ではない）
setup; unconfirmed; stops_after stopped
out=$(rec --role design --restart 2>&1); rc=$?
st=$(grep -n 'worker-stop' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
sl=$(grep -n 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1 | cut -d: -f1)
ws=$(grep 'worker-start' "$ORCA_STUB_DIR/calls.log" | head -1)
[[ "$rc" -eq 0 && -n "$st" && -n "$sl" && "$st" -lt "$sl" && "$ws" == *'--retry-of ctx_old'* \
   && ! -e "$SD/roles/design/stopped.json" ]] \
  && grep 'worker-stop' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--dispatch ctx_old' \
  && jq -e '.roles.design | .dispatch == "ctx_new" and .terminal == "term_new" and .generation == 2
            and .superseded == ["ctx_old"] and (has("start_incomplete") | not)' "$SD/workers.json" >/dev/null \
  && ok "RC33 --restart は止めてから置き換える" || fail "RC33 (rc=$rc out=$out)"
teardown

# RC34: 止められなければ置き換えない（fence が先）。記録も印もそのまま
setup; unconfirmed
printf '%s\n' '{"ok":false,"error":{"code":"dispatch_not_found","message":"stub"}}' > "$ORCA_STUB_DIR/orchestration_worker-stop"
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-stop.rc"
out=$(rec --role design --restart 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'did not stop'* && "$(did_)" == ctx_old ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && jq -e '.roles.design.start_incomplete == true' "$SD/workers.json" >/dev/null \
  && ok "RC34 止められなければ置き換えない" || fail "RC34 (rc=$rc out=$out)"
teardown

# RC35: ★ **stop が通っても、Orca がまだ start_unknown と言う間は置き換えない**（Review Focus 4）。次の回復は、
#       stopped と証明された起動をふつうに置き換える
setup; unconfirmed
out=$(rec --role design --restart 2>&1); first=$?
first_start=$(grep -c 'worker-start' "$ORCA_STUB_DIR/calls.log")
show stopped failed; : > "$ORCA_STUB_DIR/calls.log"
rec >/dev/null 2>&1; second=$?
[[ "$first" -eq 1 && "$first_start" -eq 0 && "$out" == *'Run this again'* && "$second" -eq 0 && "$(did_)" == ctx_new ]] \
  && ok "RC35 stopped と証明されるまで置き換えない" || fail "RC35 ($first/$second out=$out)"
teardown

# RC36: Orca が後から live と言った起動は、--adopt できて --restart はしない（Review Focus 3）
setup; failed_start
upd=$(jq -c '.roles.design.start_incomplete = true' "$SD/workers.json"); printf '%s\n' "$upd" > "$SD/workers.json"
echo '{"ok":true,"result":{"worker":{"state":"active","agentTerminalHandle":"term_u"},"dispatch":{"status":"dispatched"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
rec --role design --restart >/dev/null 2>&1; a=$?; a_acted=$(acted)
rec --role design --adopt >/dev/null 2>&1; b=$?
[[ "$a" -eq 1 && -z "$a_acted" && "$b" -eq 0 ]] \
  && jq -e '.roles.design | .terminal == "term_u" and (has("start_incomplete") | not)' "$SD/workers.json" >/dev/null \
  && ok "RC36 live の起動は引き受けられ、止めない" || fail "RC36 ($a/$b)"
teardown

# RC37: --dry-run は --adopt / --restart でも判断だけを出す
setup; unconfirmed; before=$(jq -c . "$SD/workers.json")
a=$(rec --role design --adopt --dry-run 2>/dev/null); ra=$?
b=$(rec --role design --restart --dry-run 2>/dev/null); rb=$?
[[ "$ra" -eq 0 && "$a" == 'design: adopt the start (terminal term_u)' && "$rb" -eq 0 \
   && "$b" == 'design: stop the start, then replace it' && -z "$(acted)" \
   && "$(jq -c . "$SD/workers.json")" == "$before" ]] \
  && ok "RC37 --dry-run は判断だけ" || fail "RC37 ($ra/$rb a=$a b=$b)"
teardown

# ── codex のフォルダの信頼（agent-trust-workspace）────────────────────────────────────────────
trust_show() {   # 起動が codex の「Trust this folder?」で止まったと Orca が言う
  jq -nc '{ok:true,result:{worker:{state:"failed",stage:"agent_readiness",agentTerminalHandle:"term_old",
      lastError:"Agent startup blocked: agent-trust-workspace"},
      dispatch:{status:"failed",lastFailure:"Agent startup blocked: agent-trust-workspace"}}}' \
    > "$ORCA_STUB_DIR/orchestration_worker-show"
}

# RC38: ★ **信頼で止まった起動は、--dry-run で解き方を見せる**（信頼しないまま置き換えると同じ画面で止まる）。
#       ふつうの失敗には出さない
setup; failed_start; trust_show
so=$(rec --dry-run 2>/dev/null); se=$(rec --dry-run 2>&1 >/dev/null)
teardown
setup; failed_start; show failed failed
plain=$(rec --dry-run 2>&1)
[[ "$so" == *'design: replace the failed start'* && "$se" == *'agent-trust-workspace'* && "$se" == *'term_old'* \
   && "$se" == *'[projects."/tmp"]'* && "$se" == *'trust_level = "trusted"'* && "$plain" != *'trust_level'* ]] \
  && ok "RC38 信頼で止まった起動は解き方を見せる" || fail "RC38 (so=$so se=$se)"
teardown

# RC39: ★ **置き換えも信頼で止まったら、その場で解き方を言う。**置き換えた試行の worker-show を読む
setup; failed_start; trust_show
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'ctx_retry'* && "$out" == *'trust_level = "trusted"'* \
   && "$out" == *'orca-recover.ts --status-dir'* ]] \
  && grep 'worker-show' "$ORCA_STUB_DIR/calls.log" | grep -q -- '--dispatch ctx_retry' \
  && ok "RC39 置き換えが信頼で止まれば解き方を言う" || fail "RC39 (rc=$rc out=$out)"
teardown

# ── 置き換えた試行の完了の記録（round 1・2 のレビュー F1）─────────────────────────────────────────
# ★ 新しい worker は ready を報告する前から動いていることがあり（start_unknown）、worker-start が返る前に prepare / await を
#   走らせうる。前の試行の記録は、新しい worker を起こす**前に**退避する。起こしたあとは completion.json に触らない
starting_worker() {   # worker-start の最中に、新しい worker が完了の口を走らせる（$1 = await まで走らせるなら 1）
  cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<HOOK
#!/usr/bin/env bash
node "$CMP" --role-dir "$SD/roles/design" prepare > "\$ORCA_STUB_DIR/new-nonce"
node "$CMP" --role-dir "$SD/roles/design" sent
[[ "${1:-}" == 1 ]] && ORCA_TERMINAL_HANDLE=term_u node "$CMP" --role-dir "$SD/roles/design" await > "\$ORCA_STUB_DIR/new-await" 2>/dev/null
exit 0
HOOK
  chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"
}
unready_retry() {   # 置き換えは ready を報告しない（dispatch は返る）
  echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
  echo '{"ok":false,"result":{"state":"outcome_unknown","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
}

# RC40: ★ **起動の最中に動き出した新しい worker は、前の試行の受理を読まない。**前の試行は accepted（worker_done を
#       送れずに失われた）。新しい worker は自分の nonce で offer し、親の受理を待つ（await は waiting）。回復が終わっても
#       その記録は残り、退避した前の試行の記録は消える
setup; owed_accepted; old_nonce=$(node "$CMP" --role-dir "$SD/roles/design" nonce); show failed
unready_retry; starting_worker 1
rec >/dev/null 2>&1; rc=$?
new_nonce=$(cat "$ORCA_STUB_DIR/new-nonce" 2>/dev/null)
[[ "$rc" -eq 1 && -n "$new_nonce" && "$new_nonce" != "$old_nonce" \
   && "$(cat "$ORCA_STUB_DIR/new-await" 2>/dev/null)" == waiting \
   && "$(node "$CMP" --role-dir "$SD/roles/design" nonce)" == "$new_nonce" \
   && "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == merge_ready_sent \
   && ! -e "$SD/roles/design/completion.superseded-ctx_old.json" && "$(did_)" == ctx_retry ]] \
  && ok "RC40 起動中に動いた新しい worker は前の試行の受理を読まない" || fail "RC40 (rc=$rc new=$new_nonce old=$old_nonce)"
teardown

# RC41: ★ **起動の最中に新しい worker が書いた記録を、回復は消さない。**前の試行に記録の無い（起動が終わらなかった）
#       役でも同じ。消すと、送った merge_ready の nonce と作り直す nonce が食い違い、await は記録無しで失敗する
setup; failed_start; show failed failed; unready_retry; starting_worker
rec >/dev/null 2>&1; rc=$?
new_nonce=$(cat "$ORCA_STUB_DIR/new-nonce" 2>/dev/null)
[[ "$rc" -eq 1 && -n "$new_nonce" && "$(node "$CMP" --role-dir "$SD/roles/design" nonce)" == "$new_nonce" \
   && "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == merge_ready_sent ]] \
  && ok "RC41 新しい worker が書いた記録は消さない" || fail "RC41 (rc=$rc new=$new_nonce)"
teardown

# RC42: 置き換えが dispatch を返さなければ、退避した記録を戻す。役はまだ前の試行を負っているので、次の回復が同じ判断をする
setup; owed_accepted; old_nonce=$(node "$CMP" --role-dir "$SD/roles/design" nonce); show failed
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"error":{"code":"runtime_unavailable"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 && "$(did_)" == ctx_old && "$(node "$CMP" --role-dir "$SD/roles/design" nonce)" == "$old_nonce" \
   && "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == accepted \
   && ! -e "$SD/roles/design/completion.superseded-ctx_old.json" ]] \
  && ok "RC42 dispatch が返らなければ退避した記録を戻す" || fail "RC42 (rc=$rc)"
teardown

# RC43: 退避先が既にあれば、新しい worker を起こさない（前の試行の記録を読む worker を作らない）
setup; owed_accepted; show failed
mkdir -p "$SD/roles/design/completion.superseded-ctx_old.json/x"   # 退避先に空でない dir を置き、rename を失敗させる
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'prior recovery stopped after parking its completion record'* && "$(did_)" == ctx_old \
   && "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == accepted ]] \
  && ! grep -q 'worker-start' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC43 退避できなければ起こさない" || fail "RC43 (rc=$rc out=$out)"
teardown

# RC44: replacement が ready にならなくても、worker-show の端末を残して cleanup に渡す
setup; failed_start; show failed failed; unready_retry
cat > "$ORCA_STUB_DIR/orchestration_worker-start.hook" <<'HOOK'
#!/usr/bin/env bash
echo '{"ok":true,"result":{"worker":{"state":"start_unknown","agentTerminalHandle":"term_retry"}}}' \
  > "$ORCA_STUB_DIR/orchestration_worker-show"
HOOK
chmod +x "$ORCA_STUB_DIR/orchestration_worker-start.hook"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && jq -e '.roles.design | .dispatch == "ctx_retry" and .terminal == "term_retry" and .start_incomplete == true' \
  "$SD/workers.json" >/dev/null \
  && ok "RC44 未 ready の replacement も Orca の端末を記録する" || fail "RC44 (rc=$rc)"
teardown

# RC45: 受領済みの失敗は起動失敗ではなく、その dispatch の決着として扱う
setup; failed_start; show failed failed
echo '{"status":"error"}' > "$SD/roles/design/status.json"
jq -c '.roles.design.start_incomplete = true' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
echo '["worker_done|task_x|ctx_old|failed"]' > "$SD/received.json"
rec >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 0 ]] && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC45 受領済みの失敗を置き換えない" || fail "RC45 (rc=$rc)"
teardown

# RC46: 受領済みの未確認 worker に --restart を付けても fence しない
setup; failed_start; show start_unknown pending
jq -c '.roles.design.start_incomplete = true' "$SD/workers.json" > "$SD/w" && mv "$SD/w" "$SD/workers.json"
echo '["worker_done|task_x|ctx_old|succeeded"]' > "$SD/received.json"
rec --role design --restart >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ! grep -qE 'worker-stop|worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC46 受領済みの worker を再起動しない" || fail "RC46 (rc=$rc)"
teardown

# RC47: 退避後に前の回復が中断されたなら、dispatch の有無を推測せず手で調べる
setup; owed_accepted; show failed
mv "$SD/roles/design/completion.json" "$SD/roles/design/completion.superseded-ctx_old.json"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'completion.superseded-ctx_old.json'* && "$out" == *'worker-list --run run_x --json'* \
   && -f "$SD/roles/design/completion.superseded-ctx_old.json" ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && ok "RC47 退避中断は推測して再開しない" || fail "RC47 (rc=$rc out=$out)"
teardown
echo "failures: $fails"; [[ "$fails" -eq 0 ]]
