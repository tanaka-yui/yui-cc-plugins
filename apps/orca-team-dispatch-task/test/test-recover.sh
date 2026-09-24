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
# ★ worker-start が ready を返さなかった役は、dispatch だけが記録され（兄弟の待機を詰まらせないため）、
#   端末は記録されず、status は `starting` のまま残る。`orca-start --phase exec` は「もう dispatch がある」と
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
#       ready でないので端末は記録せず、完了の記録も残す
setup; owe; show failed
echo 1 > "$ORCA_STUB_DIR/orchestration_worker-start.rc"
echo '{"ok":false,"result":{"state":"failed","dispatchId":"ctx_retry"}}' > "$ORCA_STUB_DIR/orchestration_worker-start"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'ctx_retry'* && -f "$SD/roles/design/completion.json" ]] \
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

# RC27: 最新の試行が outcome_unknown の間は置き換えず、記録（ctx_retry と印、古い completion）もそのまま残す
setup; owed_accepted; show failed; retry_fails
rec >/dev/null 2>&1
show outcome_unknown; : > "$ORCA_STUB_DIR/calls.log"
out=$(rec 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'its start did not complete'* ]] \
  && ! grep -qE 'worker-start|worker-release' "$ORCA_STUB_DIR/calls.log" \
  && [[ "$(node "$CMP" --role-dir "$SD/roles/design" phase)" == accepted ]] \
  && jq -e '.roles.design | .dispatch == "ctx_retry" and .start_incomplete == true' "$SD/workers.json" >/dev/null \
  && ok "RC27 最新の試行が確認できない間は何もしない" || fail "RC27 (rc=$rc out=$out)"
teardown
echo "failures: $fails"; [[ "$fails" -eq 0 ]]
