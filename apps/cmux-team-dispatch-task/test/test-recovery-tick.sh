#!/usr/bin/env bash
# recovery-tick.sh の 1 tick 判断。実 agmsg は使わず、送信は stub で記録する。
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
BIN="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/recovery-tick.sh"
ESCALATE="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts/escalate.sh"
[[ -f "$BIN" ]] || { echo "FAIL: スクリプトが見つからない: $BIN"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fail=1; }

make_send() {
  cat > "$TMP/send.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEND_LOG"
exit "${SEND_RC:-0}"
STUB
  chmod +x "$TMP/send.sh"
}
make_send

mkdir_case() { local d="$TMP/$1"; mkdir -p "$d/review"; echo "$d"; }
set_status() { jq -n --arg s "$2" '{status:$s}' > "$1/status.json"; }
write_lease() {
  jq -n --arg g "$2" --argjson s "$3" --argjson d "$4" \
    '{generation:$g, lease_seq:$s, deadline_epoch:$d}' > "$1/.gate-wait-design"
}
tick() {
  SEND_LOG="$TMP/send.log" bash "$BIN" --status-dir "$1" --role design --agent task-design \
    --team demo-team --send-command "$TMP/send.sh" 2>/dev/null
}
sends() { wc -l < "$TMP/send.log" 2>/dev/null | tr -d ' '; }
reset_log() { : > "$TMP/send.log"; }

PAST=$(( $(date +%s) - 60 ))
FUTURE=$(( $(date +%s) + 3600 ))

# --- RT1–RT4: deadline, nudge, ack ---
reset_log; d=$(mkdir_case rt1); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"
write_lease "$d" 'spec|1|design|task-design' 1 "$FUTURE"
tick "$d"
[[ "$(sends)" == 0 ]] && pass 'RT1: 期限内は何もしない' || bad "RT1: 送信した ($(sends))"

reset_log; d=$(mkdir_case rt2); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"
write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"
tick "$d"
if [[ "$(sends)" == 1 ]] && grep -q 'task-design' "$TMP/send.log" \
  && jq -e '.state == "ack_pending" and .nudges == 1' "$d/.gate-nudge-design" >/dev/null 2>&1; then
  pass 'RT2: 期限切れで self-nudge を 1 通送り ack_pending になる'
else
  bad "RT2: sends=$(sends) rec=[$(cat "$d/.gate-nudge-design" 2>/dev/null)]"
fi
tick "$d"
[[ "$(sends)" == 1 ]] && pass 'RT3: ack_pending 中は再送しない' || bad "RT3: 再送した ($(sends))"
write_lease "$d" 'spec|1|design|task-design' 2 "$FUTURE"
tick "$d"
if jq -e '.state == "waiting"' "$d/.gate-nudge-design" >/dev/null 2>&1 && [[ "$(sends)" == 1 ]]; then
  pass 'RT4: lease_seq の変化を ack として waiting へ戻る'
else
  bad "RT4: rec=[$(cat "$d/.gate-nudge-design" 2>/dev/null)] sends=$(sends)"
fi

# --- RT5–RT12: guard, escalation, closure ---
reset_log; d=$(mkdir_case rt5); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"
write_lease "$d" 'spec|1|design|task-design' 5 "$FUTURE"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"waiting",ack_deadline:0}' > "$d/.gate-nudge-design"
tick "$d"
[[ "$(sends)" == 0 && ! -f "$d/.escalated" ]] && pass 'RT5: 上限到達でも期限内なら escalation しない' \
  || bad "RT5: sends=$(sends)"
write_lease "$d" 'spec|1|design|task-design' 5 "$PAST"
tick "$d"
[[ -f "$d/.escalated" && "$(sends)" == 1 ]] && pass 'RT6: 上限到達かつ期限切れで escalation' \
  || bad "RT6: sends=$(sends)"

reset_log; d=$(mkdir_case rt7); set_status "$d" executing
printf 'findings\nVERDICT: needs_work\n' > "$d/review/spec-round-5.md"
: > "$d/.escalated"
tick "$d"
if [[ "$(sends)" == 1 ]] && grep -q ' parent ' "$TMP/send.log"; then
  pass 'RT7: VERDICT 済みでも .escalated を先に処理する'
else
  bad "RT7: sends=$(sends)"
fi
tick "$d"
[[ "$(sends)" == 1 ]] && pass 'RT8: 成功後は再送しない' || bad "RT8: 再送した ($(sends))"
rm -f "$d/.escalated"; tick "$d"
[[ ! -f "$d/.gate-nudge-design" ]] && pass 'RT9: sentinel 削除で記録を消す' || bad 'RT9: 記録が残った'
reset_log; : > "$d/.escalated"; tick "$d"
[[ "$(sends)" == 1 ]] && pass 'RT10: 解決後の再 touch は再通知する' || bad "RT10: sends=$(sends)"

reset_log; d=$(mkdir_case rt11); set_status "$d" executing; : > "$d/.escalated"
SEND_RC=1 SEND_LOG="$TMP/send.log" bash "$BIN" --status-dir "$d" --role design --agent task-design \
  --team demo-team --send-command "$TMP/send.sh" >/dev/null 2>&1
if jq -e '.state == "terminal_pending"' "$d/.gate-nudge-design" >/dev/null 2>&1; then
  tick "$d"; [[ "$(sends)" == 2 ]] && pass 'RT11: 送信失敗は次 tick で再試行する' || bad "RT11: sends=$(sends)"
else
  bad "RT11: state=[$(cat "$d/.gate-nudge-design" 2>/dev/null)]"
fi

reset_log; d=$(mkdir_case rt12); set_status "$d" done; : > "$d/.escalated"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",nudges:1,state:"waiting"}' > "$d/.gate-nudge-design"
tick "$d"
[[ "$(sends)" == 0 && ! -f "$d/.gate-nudge-design" ]] && pass 'RT12: hard closure が escalation に勝つ' \
  || bad "RT12: sends=$(sends)"

# --- RT13–RT17: disabled, generation, soft closure, delivery failure ---
reset_log; d=$(mkdir_case rt13); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"
DISPATCH_GATE_WAIT_MINUTES=0 SEND_LOG="$TMP/send.log" bash "$BIN" --status-dir "$d" --role design --agent task-design \
  --team demo-team --send-command "$TMP/send.sh" >/dev/null 2>&1
[[ "$(sends)" == 0 && ! -f "$d/.escalated" ]] && pass 'RT13: WAIT_MINUTES=0 では何もしない' || bad "RT13: sends=$(sends)"

reset_log; d=$(mkdir_case rt14); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-2-request.md"; write_lease "$d" 'spec|2|design|task-design' 9 "$PAST"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"waiting",ack_deadline:0}' > "$d/.gate-nudge-design"
tick "$d"
jq -e '.generation == "spec|2|design|task-design" and .nudges == 0' "$d/.gate-nudge-design" >/dev/null 2>&1 \
  && pass 'RT14: generation 変化で予算が 0 から再開する' || bad 'RT14: rec 不一致'

reset_log; d=$(mkdir_case rt15); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:1,nudges:0,state:"waiting",ack_deadline:0}' > "$d/.gate-nudge-design"
tick "$d"
[[ "$(sends)" == 0 && ! -f "$d/.gate-nudge-design" ]] && pass 'RT15: lease 欠落では送らない' || bad "RT15: sends=$(sends)"

reset_log; d=$(mkdir_case rt16); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; printf 'findings\nVERDICT: approve\n' > "$d/review/spec-round-1.md"
write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"
jq -n --argjson t "$(( $(date +%s) - 300 ))" '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:1,nudges:1,state:"ack_pending",ack_deadline:$t}' > "$d/.gate-nudge-design"
tick "$d"
[[ "$(sends)" == 0 && ! -f "$d/.gate-nudge-design" ]] && pass 'RT16: VERDICT は正常終了' || bad "RT16: sends=$(sends)"

reset_log; d=$(mkdir_case rt17); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"
SEND_RC=1 SEND_LOG="$TMP/send.log" bash "$BIN" --status-dir "$d" --role design --agent task-design \
  --team demo-team --send-command "$TMP/send.sh" >/dev/null 2>&1
jq -e '.state == "terminal_pending" and .nudges == 0' "$d/.gate-nudge-design" >/dev/null 2>&1 \
  && pass 'RT17: self-nudge 失敗は予算を消費しない' || bad 'RT17: rec 不一致'

# --- RT18–RT25: token, dedupe, notification contracts ---
reset_log; d=$(mkdir_case rt18); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; write_lease "$d" 'spec|1|design|task-design' 5 "$PAST"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"waiting",ack_deadline:0}' > "$d/.gate-nudge-design"
tick "$d"; tick "$d"
[[ "$(sends)" == 1 ]] && pass 'RT18: 予算超過の escalation を二重通知しない' || bad "RT18: sends=$(sends)"

reset_log; d=$(mkdir_case rt19); set_status "$d" executing
bash "$ESCALATE" "$d"; tick "$d"; rm -f "$d/.escalated"; bash "$ESCALATE" "$d"; tick "$d"
[[ "$(sends)" == 2 ]] && pass 'RT19: poll 間の再 escalation を token で再通知する' || bad "RT19: sends=$(sends)"

reset_log; d=$(mkdir_case rt20); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"; tick "$d"
write_lease "$d" 'spec|1|design|task-design' 2 "$PAST"; tick "$d"; tick "$d"
write_lease "$d" 'spec|1|design|task-design' 3 "$FUTURE"; tick "$d"; tick "$d"
[[ "$(sends)" == 2 && ! -f "$d/.escalated" ]] && pass 'RT20: ack 後は新しい deadline まで待つ' || bad "RT20: sends=$(sends)"

reset_log; d=$(mkdir_case rt21); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-2-request.md"; write_lease "$d" 'spec|2|design|task-design' 9 "$FUTURE"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"terminal_pending",ack_deadline:0}' > "$d/.gate-nudge-design"
SEND_RC=1 SEND_LOG="$TMP/send.log" bash "$BIN" --status-dir "$d" --role design --agent task-design --team demo-team --send-command "$TMP/send.sh" >/dev/null 2>&1
jq -e '.generation == "spec|2|design|task-design" and .nudges == 0 and .superseded_from == "spec|1|design|task-design"' "$d/.gate-nudge-design" >/dev/null 2>&1 \
  && pass 'RT21: supersession の失敗を記録する' || bad 'RT21: rec 不一致'

d=$(mkdir_case rt22); write_lease "$d" 'spec|1|design|task-design' 7 "$FUTURE"
lease_helper="$TMP/lease-unchanged.sh"
sed -n '/^lease_unchanged()/,/^}/p' "$BIN" > "$lease_helper"
(
  LEASE="$d/.gate-wait-design"
  lease_get() { jq -r --arg k "$1" '.[$k] // empty' "$LEASE" 2>/dev/null; }
  . "$lease_helper"
  lease_unchanged 'spec|1|design|task-design' 7 || exit 1
  lease_unchanged 'spec|2|design|task-design' 7 && exit 2
  lease_unchanged 'spec|1|design|task-design' 8 && exit 3
  rm -f "$LEASE"; lease_unchanged 'spec|1|design|task-design' 7 && exit 4
  exit 0
)
[[ $? -eq 0 ]] && pass 'RT22: 送信直前の再検証が競合を弾く' || bad 'RT22: 再検証が競合を弾かない'

reset_log; d=$(mkdir_case rt23); set_status "$d" executing; bash "$ESCALATE" "$d"; tick "$d"
line=$(head -1 "$TMP/send.log")
[[ "$line" == "demo-team task-design parent dispatch-notify: [escalation] task-design escalated $d token="* ]] \
  && pass 'RT23a: escalation 通知 contract' || bad "RT23a: [$line]"
reset_log; d=$(mkdir_case rt23b); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-1-request.md"; write_lease "$d" 'spec|1|design|task-design' 1 "$PAST"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:1,nudges:1,state:"terminal_pending",ack_deadline:0}' > "$d/.gate-nudge-design"; tick "$d"
line=$(head -1 "$TMP/send.log")
[[ "$line" == "demo-team task-design parent dispatch-notify: [recovery] task-design unreachable for spec|1|design|task-design nudges=1."* ]] \
  && pass 'RT23b: recovery 通知 contract' || bad "RT23b: [$line]"
reset_log; d=$(mkdir_case rt23c); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-2-request.md"; write_lease "$d" 'spec|2|design|task-design' 9 "$FUTURE"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"terminal_pending",ack_deadline:0}' > "$d/.gate-nudge-design"; tick "$d"
line=$(head -1 "$TMP/send.log")
[[ "$line" == "demo-team task-design parent dispatch-notify: [recovery] task-design superseded spec|1|design|task-design."* ]] \
  && pass 'RT23c: superseded 通知 contract' || bad "RT23c: [$line]"

reset_log; d=$(mkdir_case rt24); set_status "$d" executing
printf 'req\n' > "$d/review/spec-round-2-request.md"; write_lease "$d" 'spec|2|design|task-design' 9 "$FUTURE"
jq -n '{mode:"wait",generation:"spec|1|design|task-design",lease_seq_at_send:4,nudges:2,state:"terminal_pending",ack_deadline:0}' > "$d/.gate-nudge-design"; tick "$d"
jq -e 'has("superseded_from") | not' "$d/.gate-nudge-design" >/dev/null 2>&1 \
  && pass 'RT24: 成功時に superseded_from を残さない' || bad 'RT24: superseded_from が残った'

cat > "$TMP/send-then-lock.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SEND_LOG"
[[ -n "${LOCK_DIR:-}" ]] && chmod a-w "$LOCK_DIR" 2>/dev/null
exit 0
STUB
chmod +x "$TMP/send-then-lock.sh"
reset_log; d=$(mkdir_case rt25); set_status "$d" executing; bash "$ESCALATE" "$d"
for _i in 1 2 3 4; do
  SEND_LOG="$TMP/send.log" LOCK_DIR="$d" bash "$BIN" --status-dir "$d" --role design --agent task-design \
    --team demo-team --send-command "$TMP/send-then-lock.sh" >/dev/null 2>&1
done
chmod u+w "$d"
[[ "$(sends)" == 4 ]] && pass 'RT25: post-send の記録失敗では tick ごとに再送する' || bad "RT25: sends=$(sends)"

# --- RT27: progress lease も review state が無いまま回復対象になる ---
reset_log; d=$(mkdir_case rt27); set_status "$d" executing
write_lease "$d" 'progress|design|task-design' 1 "$PAST"; tick "$d"
[[ "$(sends)" == 1 ]] && pass 'RT27: 進捗 lease の期限切れで nudge する' || bad "RT27: sends=$(sends)"

[[ $fail -eq 0 ]] && echo '--- all passed ---' || echo '--- failures ---'
exit $fail
