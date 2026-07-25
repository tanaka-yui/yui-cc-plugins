#!/usr/bin/env bash
# GitHub issue 自動ループのバッチ完了待ち。
set -euo pipefail
die() { echo "Error: $1" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; FETCH="$SCRIPT_DIR/issue-fetch.sh"
STATE_FILE=""; BATCH=""; TIMEOUT_MIN=90; MAX_WAIT_SEC=540
while [[ $# -gt 0 ]]; do case "$1" in
  --state-file) STATE_FILE="$2"; shift 2 ;; --batch) BATCH="$2"; shift 2 ;;
  --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;; --max-wait-sec) MAX_WAIT_SEC="$2"; shift 2 ;;
  *) die "unknown option: $1" ;; esac; done
[[ -n "$STATE_FILE" && -n "$BATCH" ]] || die "--state-file and --batch are required"
command -v jq >/dev/null 2>&1 || die "jq is not installed"
LOOP_DIR="$(cd "$(dirname "$STATE_FILE")" && pwd)"; DISPATCH_DIR="${DISPATCH_DIR:-$(dirname "$LOOP_DIR")/.dispatch}"; SENTINEL_DIR="$LOOP_DIR/timed-out"
now_epoch() { date -u +%s; }
iso_to_epoch() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null || echo 0; }
state_write() {
  local filter="$1"; shift
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed before state write"
  local tmp; tmp=$(mktemp "$STATE_FILE.XXXXXX") || die "mktemp failed"
  jq "$@" "$filter" "$STATE_FILE" > "$tmp" || { rm -f "$tmp"; die "failed to update state"; }; mv "$tmp" "$STATE_FILE"
}
bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed"
mkdir -p "$SENTINEL_DIR"; deadline=$(( $(now_epoch) + MAX_WAIT_SEC ))
while :; do
  total=0; terminal=0; done_count=0; error_count=0; timeout_count=0; new_timeout=0
  for issue in $(jq -r --argjson batch "$BATCH" '.issues | to_entries[] | select(.value.batch == $batch) | .key' "$STATE_FILE"); do
    status=$(jq -r --arg issue "$issue" '.issues[$issue].status' "$STATE_FILE"); slug=$(jq -r --arg issue "$issue" '.issues[$issue].slug' "$STATE_FILE")
    case "$status" in
      claimed) continue ;; done) total=$((total+1)); terminal=$((terminal+1)); done_count=$((done_count+1)); continue ;;
      error) total=$((total+1)); terminal=$((terminal+1)); error_count=$((error_count+1)); continue ;;
      timeout) total=$((total+1)); terminal=$((terminal+1)); timeout_count=$((timeout_count+1)); continue ;;
    esac
    total=$((total+1)); task_status=$(jq -r '.status // "unknown"' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo unknown)
    if [[ "$task_status" == done || "$task_status" == error ]]; then
      pr=$(jq -r '.pr_url // empty' "$DISPATCH_DIR/$slug/status.json" 2>/dev/null || echo "")
      state_write '.issues[$issue].status=$status | (if $pr == "" then . else .issues[$issue].pr_url=$pr end)' --arg issue "$issue" --arg status "$task_status" --arg pr "$pr"
      terminal=$((terminal+1)); [[ "$task_status" == done ]] && done_count=$((done_count+1)) || error_count=$((error_count+1)); continue
    fi
    claimed_at=$(jq -r --arg issue "$issue" '.issues[$issue].claimed_at // empty' "$STATE_FILE")
    if [[ -n "$claimed_at" ]] && (( $(now_epoch) - $(iso_to_epoch "$claimed_at") > TIMEOUT_MIN * 60 )); then
      : > "$SENTINEL_DIR/$slug" || true
      if mkdir -p "$DISPATCH_DIR/$slug" 2>/dev/null && jq -n --arg message "timeout after $TIMEOUT_MIN min" '{status:"error",message:$message,timestamp:(now|todate)}' > "$DISPATCH_DIR/$slug/status.json" 2>/dev/null; then
        state_write '.issues[$issue].status="timeout" | .issues[$issue].message=$message' --arg issue "$issue" --arg message "timeout after $TIMEOUT_MIN min"
      else
        state_write '.issues[$issue].status="timeout" | .leaked += [$reason]' --arg issue "$issue" --arg reason "slug=$slug status.json の timeout 書き込みに失敗"
      fi
      terminal=$((terminal+1)); timeout_count=$((timeout_count+1)); new_timeout=$((new_timeout+1))
    fi
  done
  if (( terminal >= total )); then echo "ALL_TERMINAL $done_count/$error_count/$timeout_count"; exit 0; fi
  now=$(now_epoch)
  if (( now >= deadline )); then (( new_timeout > 0 )) && echo "WAITING $terminal/$total timed-out:$new_timeout" || echo "WAITING $terminal/$total"; exit 0; fi
  bash "$FETCH" --state-file "$STATE_FILE" heartbeat >/dev/null || die "loop lock owner check failed mid-wait"
  remaining=$(( deadline - now )); (( remaining > 5 )) && remaining=5; sleep "$remaining"
done
