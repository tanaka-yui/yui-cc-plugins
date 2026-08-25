#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBDIR="$SCRIPT_DIR/../skills/cmux-e2e/scripts/lib"
export PATH="$SCRIPT_DIR/stub:$PATH"
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$LIBDIR/common.sh"; source "$LIBDIR/surface.sh"
reg=$(cmux_e2e_surface_registry_path); cmux_e2e_mkdir_secure "$(dirname "$reg")"
write_reg() { jq -n --arg id "$1" --arg ref "$2" --arg wt "$PWD" '{surface_id:$id,surface_ref:$ref,worktree:$wt}' > "$reg"; }
cmux_e2e_surface_resolve >/dev/null 2>&1; h_check 'state A' 10 $?
write_reg UUID-1 surface:9; h_tree UUID-OTHER surface:5 browser
cmux_e2e_surface_resolve >/dev/null 2>&1; h_check 'state B' 11 $?
h_tree UUID-1 surface:5 terminal
cmux_e2e_surface_resolve >/dev/null 2>&1; h_check 'state B-prime' 12 $?
h_tree UUID-1 surface:5 browser; export CMUX_STUB_IDENTIFY_REF=surface:7
cmux_e2e_surface_resolve >/dev/null 2>&1; h_check 'state C' 13 $?
unset CMUX_STUB_IDENTIFY_REF
got=$(cmux_e2e_surface_resolve); h_check 'resolve current ref' surface:5 "$got"
h_check 'registry updated' surface:5 "$(jq -r .surface_ref "$reg")"
h_tree UUID-CREATED surface:8 browser
created=$(CMUX_STUB_NEW_REF=surface:8 cmux_e2e_surface_create)
h_check 'created surface ref' surface:8 "$created"
expected_git_dir=$(cmux_e2e_worktree_git_dir)
h_check 'created record persists worktree git dir' "$expected_git_dir" "$(jq -r .git_dir "$reg")"
h_assert_no_import
exit "$(h_fail_count)"
