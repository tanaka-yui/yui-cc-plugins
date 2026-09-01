#!/usr/bin/env bash
# recovery-tick.sh — 停止したペインを外側から回復する 1 tick 分の判断。ループは持たない。
set -uo pipefail

status_dir=""
role=""
agent=""
team=""
send_command=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --status-dir) status_dir="${2:-}"; shift 2 ;;
    --role) role="${2:-}"; shift 2 ;;
    --agent) agent="${2:-}"; shift 2 ;;
    --team) team="${2:-}"; shift 2 ;;
    --send-command) send_command="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$status_dir" && -n "$role" && -n "$agent" && -d "$status_dir" ]] || exit 0
if [[ -z "$send_command" && -r "$status_dir/.send-command" ]]; then
  IFS= read -r send_command < "$status_dir/.send-command" || send_command=""
fi

wait_minutes="${DISPATCH_GATE_WAIT_MINUTES:-30}"
ack_grace="${DISPATCH_RECOVERY_ACK_GRACE:-120}"
max_nudges="${DISPATCH_RECOVERY_MAX_NUDGES:-2}"
[[ "$wait_minutes" =~ ^[0-9]+$ ]] || exit 0
[[ "$ack_grace" =~ ^[0-9]+$ ]] || ack_grace=120
[[ "$max_nudges" =~ ^[0-9]+$ ]] || max_nudges=2
[[ "$wait_minutes" -gt 0 ]] || exit 0

LEASE="$status_dir/.gate-wait-$role"
record="$status_dir/.gate-nudge-$role"
now=$(date +%s)
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
escalate_bin="$script_dir/escalate.sh"

record_get() { jq -r --arg key "$1" '.[$key] // empty' "$record" 2>/dev/null; }
lease_get() { jq -r --arg key "$1" '.[$key] // empty' "$LEASE" 2>/dev/null; }
record_clear() { rm -f "$record" 2>/dev/null || true; }
record_write() {
  local tmp
  tmp=$(mktemp "$status_dir/.gate-nudge.XXXXXX" 2>/dev/null) || return 1
  printf '%s\n' "$1" > "$tmp" 2>/dev/null && mv -f "$tmp" "$record" 2>/dev/null || {
    rm -f "$tmp"
    return 1
  }
}
send_to() {
  [[ -n "$send_command" && -n "$team" ]] || return 1
  bash "$send_command" "$team" "$agent" "$1" "$2" >/dev/null 2>&1
}
notify_body() {
  case "$1" in
    escalation) printf 'dispatch-notify: [escalation] %s escalated %s token=%s. It is waiting for a parent decision and cannot proceed on its own.' "$agent" "$status_dir" "$2" ;;
    recovery) printf 'dispatch-notify: [recovery] %s unreachable for %s nudges=%s. A recovery nudge could not be confirmed.' "$agent" "$2" "${3:-0}" ;;
    superseded) printf 'dispatch-notify: [recovery] %s superseded %s. A newer review generation started before the earlier recovery notice was delivered.' "$agent" "$2" ;;
  esac
}
escalation_identity() {
  local token
  [[ -f "$status_dir/.escalated" ]] || return 1
  token=$(head -c 200 "$status_dir/.escalated" 2>/dev/null | tr -d '\r\n')
  [[ -n "$token" ]] || token="legacy-untokenized"
  printf '%s' "$token"
}

status=$(jq -r '.status // empty' "$status_dir/status.json" 2>/dev/null || echo "")
case "$status" in
  done|error) record_clear; exit 0 ;;
esac

# Escalation is checked before soft closure because a round-cap child writes its VERDICT first.
if [[ -f "$status_dir/.escalated" ]]; then
  token=$(escalation_identity) || exit 0
  if [[ "$(record_get mode)" != escalated || "$(record_get escalation_token)" != "$token" ]]; then
    record_write "$(jq -nc --arg token "$token" '{mode:"escalated", escalation_token:$token, state:"terminal_pending"}')" \
      || { echo 'recovery-tick: cannot persist escalation record; not sending' >&2; exit 0; }
  fi
  [[ "$(record_get state)" == terminal_done ]] && exit 0
  [[ "$(escalation_identity 2>/dev/null)" == "$token" ]] || exit 0
  if send_to parent "$(notify_body escalation "$token")"; then
    record_write "$(jq -nc --arg token "$token" '{mode:"escalated", escalation_token:$token, state:"terminal_done"}')" \
      || echo 'recovery-tick: sent but cannot persist terminal_done; may resend' >&2
  fi
  exit 0
fi
[[ "$(record_get mode)" == escalated ]] && { record_clear; exit 0; }

# review-state.sh is the sole authority for closure and active review generation.
# shellcheck disable=SC1090
. "$script_dir/review-state.sh"
review_select_active "$status_dir"
[[ "$RS_SOFT_CLOSED" == 1 ]] && { record_clear; exit 0; }

[[ -f "$LEASE" ]] || { record_clear; exit 0; }
generation=$(lease_get generation)
lease_seq=$(lease_get lease_seq)
deadline=$(lease_get deadline_epoch)
[[ -n "$generation" && "$lease_seq" =~ ^[0-9]+$ && "$deadline" =~ ^[0-9]+$ ]] || exit 0
if [[ -n "$RS_POINT" && "$generation" != "$RS_POINT|$RS_ROUND|$role|$agent" ]]; then
  exit 0
fi

if [[ "$(record_get generation)" != "$generation" ]]; then
  old_generation=$(record_get generation)
  old_state=$(record_get state)
  superseded=""
  if [[ "$old_state" == terminal_pending && -n "$old_generation" ]]; then
    send_to parent "$(notify_body superseded "$old_generation")" || superseded="$old_generation"
  fi
  record_write "$(jq -nc --arg generation "$generation" --arg superseded "$superseded" '
    {mode:"wait", generation:$generation, lease_seq_at_send:0, nudges:0, state:"waiting", ack_deadline:0}
    + (if $superseded == "" then {} else {superseded_from:$superseded} end)
  ')" || exit 0
  # Only a replacement generation gets a fresh tick. The first-ever record must still be
  # eligible to nudge when its lease has already expired.
  [[ -n "$old_generation" ]] && exit 0
fi

state=$(record_get state)
[[ -n "$state" ]] || state=waiting
nudges=$(record_get nudges)
lease_seq_at_send=$(record_get lease_seq_at_send)
ack_deadline=$(record_get ack_deadline)
[[ "$nudges" =~ ^[0-9]+$ ]] || nudges=0
[[ "$lease_seq_at_send" =~ ^[0-9]+$ ]] || lease_seq_at_send=0
[[ "$ack_deadline" =~ ^[0-9]+$ ]] || ack_deadline=0
put() {
  record_write "$(jq -nc --arg generation "$generation" --arg state "$1" --argjson nudges "$2" --argjson sent "$3" --argjson deadline "$4" \
    '{mode:"wait", generation:$generation, lease_seq_at_send:$sent, nudges:$nudges, state:$state, ack_deadline:$deadline}')"
}
lease_unchanged() {
  [[ -f "$LEASE" ]] || return 1
  [[ "$(lease_get generation)" == "$1" && "$(lease_get lease_seq)" == "$2" ]]
}

case "$state" in
  terminal_done) exit 0 ;;
  terminal_pending)
    if send_to parent "$(notify_body recovery "$generation" "$nudges")"; then
      put terminal_done "$nudges" "$lease_seq_at_send" "$ack_deadline" \
        || echo 'recovery-tick: sent but cannot persist terminal_done; may resend' >&2
    fi
    exit 0
    ;;
  ack_pending)
    if [[ "$lease_seq" != "$lease_seq_at_send" ]]; then
      put waiting "$nudges" "$lease_seq" 0
    elif (( now > ack_deadline )); then
      put terminal_pending "$((nudges > 0 ? nudges - 1 : 0))" "$lease_seq_at_send" "$ack_deadline"
    fi
    exit 0
    ;;
  waiting)
    (( now > deadline )) || exit 0
    if (( nudges >= max_nudges )); then
      bash "$escalate_bin" "$status_dir" 2>/dev/null || { echo 'recovery-tick: cannot create .escalated' >&2; exit 0; }
      token=$(escalation_identity) || exit 0
      record_write "$(jq -nc --arg token "$token" '{mode:"escalated", escalation_token:$token, state:"terminal_pending"}')" \
        || { echo 'recovery-tick: cannot persist escalation record; not sending' >&2; exit 0; }
      if send_to parent "$(notify_body escalation "$token")"; then
        record_write "$(jq -nc --arg token "$token" '{mode:"escalated", escalation_token:$token, state:"terminal_done"}')" \
          || echo 'recovery-tick: sent but cannot persist terminal_done; may resend' >&2
      fi
      exit 0
    fi
    lease_unchanged "$generation" "$lease_seq" || { [[ -f "$LEASE" ]] || record_clear; exit 0; }
    put ack_pending "$((nudges + 1))" "$lease_seq" "$((now + ack_grace))" \
      || { echo 'recovery-tick: cannot persist nudge record; not sending' >&2; exit 0; }
    if ! send_to "$agent" "dispatch-nudge: you appear to be stopped while waiting on $generation. Re-check the findings file for a VERDICT line and continue; if the reviewer is unreachable, follow the abort procedure."; then
      put terminal_pending "$nudges" "$lease_seq" 0 \
        || echo 'recovery-tick: cannot persist fallback record' >&2
    fi
    exit 0
    ;;
esac
