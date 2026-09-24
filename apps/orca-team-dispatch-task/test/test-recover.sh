#!/usr/bin/env bash
# owner の回復（spec 10-1 の表 / F-e）。**確認できないものに replacement を作らないこと**が
# 全部である。旧 capability と新 capability が同時に lifecycle を進めてはならない。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
R="$P/bin/orca-recover.sh"
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
rec() { bash "$R" --status-dir "$SD" "$@"; }
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

echo "failures: $fails"; [[ "$fails" -eq 0 ]]
