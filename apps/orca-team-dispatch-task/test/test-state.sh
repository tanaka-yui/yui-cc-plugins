#!/usr/bin/env bash
# SKILL.md の block が jq で読んでいた状態を 1 行で返す入口（設計 6 章）。**読むだけで何も書かない**ことと、
# 読めないものを「無い」と取り違えないこと（integration / mailbox / accounts は exit 1 で言う）を確かめる。
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"
STATE_TS="$P/bin/orca-state.ts"
fails=0; ok() { echo "PASS: $1"; }; fail() { echo "FAIL: $1"; fails=$((fails+1)); }

setup() {
  ORCA_STUB_DIR=$(mktemp -d); export ORCA_STUB_DIR ORCA_BIN="$P/test/lib/orca-stub.sh"
  : > "$ORCA_STUB_DIR/calls.log"
  SD=$(mktemp -d); mkdir -p "$SD/roles/design"
}
teardown() { rm -rf "$ORCA_STUB_DIR" "$SD"; unset ORCA_STUB_DIR ORCA_BIN; }
st() { node "$STATE_TS" "$@"; }

# OS1: 使用法の誤りは exit 2（読めない 1 と区別する）
setup; bad=""
st >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [no-command]"
st bogus --status-dir "$SD" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [unknown-command]"
st wait-stamp >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [no-status-dir]"
st design-status --status-dir "$SD" --bogus >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [unknown-flag]"
st accounts --status-dir "$SD" >/dev/null 2>&1; [[ $? -eq 2 ]] || bad="$bad [accounts-flag]"
[[ -z "$bad" ]] && ok "OS1 使用法の誤りは 2" || fail "OS1:$bad"; teardown

# OS2: wait-stamp は Step 3 の jq と同じ 1 行を出す（age は 今 − beat、window は window_ms / 1000）
setup
printf '{"pid":1,"beat":%s,"window_ms":300000}\n' "$(( $(date +%s) - 42 ))" > "$SD/wait.json"
out=$(st wait-stamp --status-dir "$SD"); rc=$?
age=$(sed -n 's/^age=\([0-9][0-9]*\)s window=300s$/\1/p' <<<"$out")
[[ "$rc" -eq 0 && -n "$age" && "$age" -ge 42 && "$age" -le 47 ]] \
  && ok "OS2 wait-stamp は age と window を出す" || fail "OS2 (rc=$rc out=$out)"; teardown

# OS3: window は jq と同じく小数のまま出す（テストでは 1500 ms などの短い窓を使う）
setup
printf '{"pid":1,"beat":%s,"window_ms":1500}\n' "$(date +%s)" > "$SD/wait.json"
[[ "$(st wait-stamp --status-dir "$SD")" == *' window=1.5s' ]] \
  && ok "OS3 window の小数を jq と同じ形で出す" || fail "OS3"; teardown

# OS4: 鼓動が無い・壊れている・数でないときは、jq が失敗したときと同じ文を出して exit 0
setup; bad=""
[[ "$(st wait-stamp --status-dir "$SD")" == 'no wait has ever stamped this task' ]] || bad="$bad [absent]"
printf '{' > "$SD/wait.json"
[[ "$(st wait-stamp --status-dir "$SD")" == 'no wait has ever stamped this task' ]] || bad="$bad [broken]"
printf '{"beat":"123","window_ms":300000}\n' > "$SD/wait.json"
[[ "$(st wait-stamp --status-dir "$SD")" == 'no wait has ever stamped this task' ]] || bad="$bad [string-beat]"
printf '{"beat":123}\n' > "$SD/wait.json"
out=$(st wait-stamp --status-dir "$SD"); rc=$?
[[ "$rc" -eq 0 && "$out" == 'no wait has ever stamped this task' ]] || bad="$bad [no-window]"
[[ -z "$bad" ]] && ok "OS4 読めない鼓動は「無い」と言う" || fail "OS4:$bad"; teardown

# OS5: ★ **design-status は stopped.json を status より先に見る。**ユーザーが止めた design は、status が done でも
#      Step 3.5 で exec を起こさない
setup; bad=""
ds() { st design-status --status-dir "$SD"; }
[[ "$(ds)" == missing ]] || bad="$bad [absent]"
printf '{"status":"executing"}\n' > "$SD/roles/design/status.json"; [[ "$(ds)" == executing ]] || bad="$bad [executing]"
printf '{"status":"error"}\n' > "$SD/roles/design/status.json"; [[ "$(ds)" == error ]] || bad="$bad [error]"
printf '{"status":"done"}\n' > "$SD/roles/design/status.json"; [[ "$(ds)" == done ]] || bad="$bad [done]"
printf '{"stopped_at":1,"by":"user"}\n' > "$SD/roles/design/stopped.json"
[[ "$(ds)" == stopped ]] || bad="$bad [stopped-over-done]"
rm -f "$SD/roles/design/stopped.json"; printf '{' > "$SD/roles/design/status.json"
[[ "$(ds)" == missing ]] || bad="$bad [broken]"
[[ -z "$bad" ]] && ok "OS5 design-status は stopped を最優先に 1 語で言う" || fail "OS5:$bad"; teardown

# OS6: ★ **integration は記録を読む。キーが無い・null の旧版だけが not recorded。**読めない・object でない
#      workers.json と、知らない値（空文字・型違い・false・merge / pr 以外の文字列）は exit 1。未記録と取り違えると
#      Step 4 は設定の値で取り込み、orca-merge.ts / orca-pr.ts は相手側の値しか拒まないので止まらない
setup; bad=""
ig() { st integration --status-dir "$SD"; }
ig >/dev/null 2>&1; [[ $? -eq 1 ]] || bad="$bad [absent-file]"
printf '{"integration":"pr"}\n' > "$SD/workers.json"; [[ "$(ig)" == pr ]] || bad="$bad [pr]"
printf '{"integration":"merge"}\n' > "$SD/workers.json"; [[ "$(ig)" == merge ]] || bad="$bad [merge]"
printf '{"integration":null}\n' > "$SD/workers.json"; [[ "$(ig)" == 'not recorded' ]] || bad="$bad [null]"
printf '{"roles":{}}\n' > "$SD/workers.json"; [[ "$(ig)" == 'not recorded' ]] || bad="$bad [missing-key]"
for broken in '{' '[]' '"broken"' '{"integration":""}' '{"integration":123}' '{"integration":{}}' \
              '{"integration":false}' '{"integration":"squash"}'; do
  printf '%s\n' "$broken" > "$SD/workers.json"; out=$(ig 2>&1); rc=$?
  [[ "$rc" -eq 1 && "$out" == *'workers.json'* && "$out" != *'not recorded'* ]] || bad="$bad [$broken:$rc]"
done
[[ -z "$bad" ]] && ok "OS6 integration は未記録と不正な記録を分ける" || fail "OS6:$bad"; teardown

# OS7: ★ **mailbox は記録した親端末を --peek で覗くだけ。--ack は渡さない。**親端末が無ければ Orca を呼ばない
setup
printf '{"run_id":"run_x","parent_handle":"term_p"}\n' > "$SD/run.json"
echo '{"ok":true,"result":{"messages":[{"id":"m1","type":"odd"}]}}' > "$ORCA_STUB_DIR/orchestration_check"
out=$(st mailbox --status-dir "$SD"); rc=$?
line=$(grep '^orchestration check ' "$ORCA_STUB_DIR/calls.log")
[[ "$rc" -eq 0 && "$out" == *'"m1"'* && "$line" == 'orchestration check --terminal term_p --peek --json ' ]] \
  || fail "OS7 覗き見 (rc=$rc line=$line)"
printf '{"run_id":"run_x"}\n' > "$SD/run.json"; : > "$ORCA_STUB_DIR/calls.log"
out=$(st mailbox --status-dir "$SD" 2>&1); rc=$?
[[ "$rc" -eq 1 && "$out" == *'missing parent handle; do not acknowledge anything'* && ! -s "$ORCA_STUB_DIR/calls.log" ]] \
  && ok "OS7 mailbox は覗くだけで、親端末が無ければ何も呼ばない" || fail "OS7 (rc=$rc out=$out)"; teardown

# OS8: accounts は S1 の jq と同じ射影（ランタイムごとのアカウント id とアクティブ）だけを出す。
#      receipt に載る email や rate limit は出さない。receipt が ok でなければ 1
setup
printf '%s\n' '{"ok":true,"result":{"claude":{"accounts":[{"id":"a1","email":"x@example.com"}],"activeAccountIdsByRuntime":{"host":"a1"}},"codex":{"accounts":[],"activeAccountIdsByRuntime":{"host":null}},"rateLimits":{"claude":{}}}}' \
  > "$ORCA_STUB_DIR/account_list"
out=$(st accounts); rc=$?
[[ "$rc" -eq 0 && "$(jq -c . <<<"$out")" == '{"claude":{"accounts":["a1"],"active":{"host":"a1"}},"codex":{"accounts":[],"active":{"host":null}}}' ]] \
  || fail "OS8 射影 (rc=$rc out=$out)"
echo '{"ok":false,"error":{"code":"x"}}' > "$ORCA_STUB_DIR/account_list"
st accounts >/dev/null 2>&1; rc=$?
[[ "$rc" -eq 1 ]] && ok "OS8 accounts は id とアクティブだけを出し、読めなければ 1" || fail "OS8 (rc=$rc)"; teardown

# OS9: どの問いも status dir に何も書かない
setup
printf '{"pid":1,"beat":1,"window_ms":300000}\n' > "$SD/wait.json"
printf '{"status":"done"}\n' > "$SD/roles/design/status.json"
printf '{"integration":"merge"}\n' > "$SD/workers.json"
printf '{"parent_handle":"term_p"}\n' > "$SD/run.json"
before=$(find "$SD" -type f -exec cksum {} + | sort)
for c in wait-stamp design-status integration mailbox; do st "$c" --status-dir "$SD" >/dev/null 2>&1; done
[[ "$(find "$SD" -type f -exec cksum {} + | sort)" == "$before" ]] \
  && ok "OS9 読むだけで何も書かない" || fail "OS9"; teardown

# OS10: zsh から呼んでも同じ結果になる（設計 3-5）
if command -v zsh >/dev/null 2>&1; then
  setup; printf '{"status":"done"}\n' > "$SD/roles/design/status.json"
  b=$(bash -c 'node "$1" design-status --status-dir "$2"' bash "$STATE_TS" "$SD" 2>&1); brc=$?
  z=$(zsh -c 'node "$1" design-status --status-dir "$2"' zsh "$STATE_TS" "$SD" 2>&1); zrc=$?
  [[ "$brc" -eq 0 && "$zrc" -eq 0 && "$b" == done && "$b" == "$z" ]] \
    && ok "OS10 zsh から呼んでも同じ結果" || fail "OS10 ($brc/$zrc $b/$z)"; teardown
else
  echo "SKIP: OS10 zsh が無い"
fi
echo "---"; echo "failures: $fails"; exit "$fails"
