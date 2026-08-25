#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBDIR="$SCRIPT_DIR/../skills/cmux-e2e/scripts/lib"
export PATH="$SCRIPT_DIR/stub:$PATH"
export CMUX_BIN=cmux
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$LIBDIR/common.sh"
source "$LIBDIR/auth-core.sh"

d=$(cmux_e2e_auth_dir session)
cmux_e2e_mkdir_secure "$d"
mkdir "$d/meta.json"
auth_save_locked surface:5 session >/dev/null 2>&1
h_check 'save fails when metadata cannot be installed' 1 $?
[[ ! -e "$d/state.json" ]]; h_check 'failed metadata install rolls state back' 0 $?
h_assert_no_import
exit "$(h_fail_count)"
