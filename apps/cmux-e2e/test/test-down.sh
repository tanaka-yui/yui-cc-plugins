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
real_git=$(command -v git)
git_shim="$(h_tmp)/git-shim"
mkdir "$git_shim"
cat > "$git_shim/git" <<EOF
#!/usr/bin/env bash
if [[ "\${CMUX_STUB_GIT_WORKTREE_LIST:-ok}" == fail && "\${1:-}" == worktree && "\${2:-}" == list ]]; then exit 1; fi
exec "$real_git" "\$@"
EOF
chmod 755 "$git_shim/git"
export PATH="$git_shim:$PATH"

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

jq -n --arg wt "$PWD" '{surface_id:"UUID-MINE",surface_ref:"surface:5",worktree:$wt}' > "$reg"
moved_from="$(h_tmp)/sweep-sibling"
moved_to="$(h_tmp)/sweep-sibling-renamed"
git worktree add -q -b sweep-sibling "$moved_from"
gitdir=$(git -C "$moved_from" rev-parse --git-dir)
moved="$entries/moved.json"
jq -n --arg wt "$moved_from" --arg gd "$gitdir" '{surface_id:"UUID-MOVED",surface_ref:"surface:10",worktree:$wt,git_dir:$gd}' > "$moved"
git worktree move "$moved_from" "$moved_to"
h_tree UUID-MINE surface:5 browser UUID-MOVED surface:10 browser
: > "$CMUX_STUB_LOG"
bash "$SCRIPTS/down.sh" --sweep >/dev/null 2>&1
h_check 'moved live worktree does not prevent own down' 0 $?
[[ -f "$moved" ]]; h_check 'moved live worktree record is retained' 0 $?
if grep -q -- 'close-surface --surface surface:10' "$CMUX_STUB_LOG"; then
  echo 'FAIL - sweep closed a surface owned by a moved live worktree'
  _H_FAIL=1
else
  echo 'ok   - sweep keeps a surface owned by a moved live worktree'
fi

jq -n --arg wt "$PWD" '{surface_id:"UUID-MINE",surface_ref:"surface:5",worktree:$wt}' > "$reg"
h_tree UUID-MINE surface:5 browser UUID-MOVED surface:10 browser
: > "$CMUX_STUB_LOG"
CMUX_STUB_GIT_WORKTREE_LIST=fail bash "$SCRIPTS/down.sh" --sweep >/dev/null 2>&1
h_check 'worktree-list failure does not prevent own down' 0 $?
[[ -f "$moved" ]]; h_check 'worktree-list failure retains moved live record' 0 $?
if grep -q -- 'close-surface --surface surface:10' "$CMUX_STUB_LOG"; then
  echo 'FAIL - failed worktree listing closed a moved live surface'
  _H_FAIL=1
else
  echo 'ok   - failed worktree listing keeps a moved live surface'
fi

jq -n --arg wt "$PWD" '{surface_id:"UUID-MINE",surface_ref:"surface:5",worktree:$wt}' > "$reg"
dead_from="$(h_tmp)/sweep-dead"
git worktree add -q -b sweep-dead "$dead_from"
dead_git_dir=$(git -C "$dead_from" rev-parse --git-dir)
dead="$entries/dead.json"
jq -n --arg wt "$dead_from" --arg gd "$dead_git_dir" '{surface_id:"UUID-DEAD",surface_ref:"surface:11",worktree:$wt,git_dir:$gd}' > "$dead"
git worktree remove --force "$dead_from"
legacy="$entries/legacy.json"
jq -n '{surface_id:"UUID-LEGACY",surface_ref:"surface:12",worktree:"/definitely/missing/legacy"}' > "$legacy"
h_tree UUID-MINE surface:5 browser UUID-DEAD surface:11 browser UUID-LEGACY surface:12 browser
: > "$CMUX_STUB_LOG"
bash "$SCRIPTS/down.sh" --sweep >/dev/null 2>&1
h_check 'dead worktree does not prevent own down' 0 $?
[[ ! -f "$dead" ]]; h_check 'dead worktree record is collected' 0 $?
[[ -f "$legacy" ]]; h_check 'legacy record without git dir is retained' 0 $?
if grep -q -- 'close-surface --surface surface:11' "$CMUX_STUB_LOG"; then
  echo 'ok   - sweep closes a dead worktree surface'
else
  echo 'FAIL - sweep did not close a dead worktree surface'
  _H_FAIL=1
fi
if grep -q -- 'close-surface --surface surface:12' "$CMUX_STUB_LOG"; then
  echo 'FAIL - sweep closed a legacy record without git dir'
  _H_FAIL=1
else
  echo 'ok   - sweep keeps a legacy record without git dir'
fi
h_assert_no_import
exit "$(h_fail_count)"
