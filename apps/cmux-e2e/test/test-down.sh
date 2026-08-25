#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-e2e/scripts"
LIBDIR="$SCRIPTS/lib"
export PATH="$SCRIPT_DIR/stub:$PATH"
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$LIBDIR/common.sh"
source "$LIBDIR/lock.sh"
source "$LIBDIR/surface.sh"

reg=$(cmux_e2e_surface_registry_path)
entries=$(dirname "$reg")
cmux_e2e_mkdir_secure "$entries"
jq -n --arg wt "$PWD" '{surface_id:"UUID-MINE",surface_ref:"surface:5",worktree:$wt}' > "$reg"
printf '{broken' > "$entries/000-corrupt.json"
h_tree UUID-MINE surface:5 browser
bash "$SCRIPTS/down.sh" --sweep >/dev/null 2>&1
h_check 'corrupt stale record does not prevent own down' 0 $?
[[ ! -e "$reg" ]]; h_check 'own record removed despite corrupt stale record' 0 $?

jq -n --arg wt "$PWD" '{surface_id:"UUID-MINE",surface_ref:"surface:5",worktree:$wt}' > "$reg"
stale="$entries/stale.json"
jq -n '{surface_id:"UUID-STALE",surface_ref:"surface:9",worktree:"/definitely/missing/worktree"}' > "$stale"
sibling="$(dirname "$entries")/locks/stale"
cmux_e2e_lock_acquire "$sibling"
h_tree UUID-MINE surface:5 browser UUID-STALE surface:9 browser
: > "$CMUX_STUB_LOG"
bash "$SCRIPTS/down.sh" --sweep >/dev/null 2>&1
h_check 'locked stale worktree does not prevent own down' 0 $?
[[ -f "$stale" ]]; h_check 'locked stale record is retained' 0 $?
if grep -q -- 'close-surface --surface surface:9' "$CMUX_STUB_LOG"; then
  echo 'FAIL - sweep closed a surface protected by sibling lock'
  _H_FAIL=1
else
  echo 'ok   - sweep skips a surface protected by sibling lock'
fi
cmux_e2e_lock_release_all
h_assert_no_import
exit "$(h_fail_count)"
