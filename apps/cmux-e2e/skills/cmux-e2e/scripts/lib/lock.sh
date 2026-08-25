#!/usr/bin/env bash

_CMUX_E2E_HELD=()
_CMUX_E2E_CRITICAL=0
_CMUX_E2E_PENDING_SIG=''

_cmux_e2e_enter_critical() { _CMUX_E2E_CRITICAL=1; }
_cmux_e2e_leave_critical() {
  local sig
  _CMUX_E2E_CRITICAL=0
  if [[ -n "$_CMUX_E2E_PENDING_SIG" ]]; then
    sig="$_CMUX_E2E_PENDING_SIG"
    _CMUX_E2E_PENDING_SIG=''
    case "$sig" in INT) exit 130 ;; TERM) exit 143 ;; HUP) exit 129 ;; esac
  fi
}
_cmux_e2e_signal() {
  local sig="$1" code="$2"
  if [[ "$_CMUX_E2E_CRITICAL" -eq 1 ]]; then
    _CMUX_E2E_PENDING_SIG="$sig"
    return 0
  fi
  cmux_e2e_on_signal "$sig" "$code"
}
cmux_e2e_on_signal() { exit "$2"; }

_cmux_e2e_unhold() {
  local drop="$1" dir rest=()
  for dir in ${_CMUX_E2E_HELD[@]+"${_CMUX_E2E_HELD[@]}"}; do
    [[ "$dir" == "$drop" ]] || rest+=("$dir")
  done
  _CMUX_E2E_HELD=(${rest[@]+"${rest[@]}"})
}

cmux_e2e_lock_acquire() {
  local dir="$1" tmp info esc
  cmux_e2e_secure_path "$dir" || {
    echo "ERROR: refusing to lock outside the cache root: $dir" >&2
    return 1
  }
  cmux_e2e_mkdir_secure "$(dirname "$dir")" || return 1
  _cmux_e2e_enter_critical
  if ! mkdir -m 700 "$dir" 2>/dev/null; then
    _cmux_e2e_leave_critical
    info='holder unknown'
    if [[ -f "$dir/owner.json" ]]; then
      info=$("$CMUX_E2E_JQ" -r '"pid=\(.pid // "?") started_at=\(.started_at // "?")"' "$dir/owner.json" 2>/dev/null) || info='owner.json is unreadable'
    fi
    esc=$(printf '%q' "$dir")
    {
      echo "ERROR: could not acquire the lock ($info)."
      echo '  cmux-e2e never reclaims locks automatically.'
      echo '  If no cmux-e2e command is running, remove it by hand:'
      echo "    rm -rf -- $esc"
    } >&2
    return 1
  fi
  _CMUX_E2E_HELD+=("$dir")
  _cmux_e2e_leave_critical
  tmp="$dir/.owner.json.tmp.$$"
  if ! "$CMUX_E2E_JQ" -n --argjson pid "$$" \
    --arg wt "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{pid:$pid,worktree:$wt,started_at:$at}' > "$tmp"; then
    rm -f -- "$tmp"; _cmux_e2e_unhold "$dir"; rm -rf -- "$dir"
    return 1
  fi
  if ! cmux_e2e_install_file "$tmp" "$dir/owner.json"; then
    rm -f -- "$tmp"; _cmux_e2e_unhold "$dir"; rm -rf -- "$dir"
    return 1
  fi
}

cmux_e2e_lock_release_all() {
  local dir
  for dir in ${_CMUX_E2E_HELD[@]+"${_CMUX_E2E_HELD[@]}"}; do
    rm -rf -- "$dir"
  done
  _CMUX_E2E_HELD=()
}

cmux_e2e_install_traps() {
  trap 'cmux_e2e_lock_release_all' EXIT
  trap '_cmux_e2e_signal INT 130' INT
  trap '_cmux_e2e_signal TERM 143' TERM
  trap '_cmux_e2e_signal HUP 129' HUP
}
