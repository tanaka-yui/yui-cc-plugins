#!/usr/bin/env bash

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$SCRIPT_DIR/../skills/cmux-e2e/scripts/lib/common.sh"

cmux_e2e_validate_name 'oauth.v1'; h_check 'oauth.v1 accepted' 0 $?
cmux_e2e_validate_name '..'; h_check '.. rejected' 2 $?
cmux_e2e_validate_name '.'; h_check '. rejected' 2 $?
cmux_e2e_validate_name ''; h_check 'empty rejected' 2 $?
cmux_e2e_validate_name 'a/b'; h_check 'slash rejected' 2 $?
cmux_e2e_validate_name 'a b'; h_check 'space rejected' 2 $?

k=$(cmux_e2e_worktree_key); h_check 'worktree key rc' 0 $?
h_check 'worktree key length' 16 "${#k}"
[[ "$k" =~ ^[0-9a-f]{16}$ ]]; h_check 'worktree key is hex' 0 $?
h_check 'worktree key stable' "$k" "$(cmux_e2e_worktree_key)"

p1=$(cmux_e2e_project_key); h_check 'project key rc' 0 $?
[[ "$p1" =~ ^repo-[0-9a-f]{16}$ ]]; h_check 'project key shape' 0 $?
mkdir -p "$(h_tmp)/repo2" && (cd "$(h_tmp)/repo2" && git init -q)
p2=$(cd "$(h_tmp)/repo2" && cmux_e2e_project_key)
[[ "$p1" != "$p2" ]]; h_check 'distinct repos get distinct project keys' 0 $?
mkdir -p src
p3=$(cd src && cmux_e2e_project_key); h_check 'project key is stable from a subdirectory' "$p1" "$p3"

printf 'project: myproj\n' > .dev-up.yaml
if command -v yq >/dev/null 2>&1; then
  h_check 'dev-up project wins' myproj "$(cmux_e2e_project_key)"
else
  echo 'skip - yq not installed (dev-up project resolution)'
fi
out=$(CMUX_E2E_YQ="$(h_tmp)/no-such-yq" cmux_e2e_project_key 2>/dev/null); rc=$?
h_check 'fail-close without yq (rc)' 1 "$rc"
h_check 'fail-close without yq (empty)' '' "$out"
rm -f .dev-up.yaml

umask 000
root=$(cmux_e2e_cache_root)
cmux_e2e_mkdir_secure "$root/proj/auth/entries/x"; h_check 'mkdir_secure rc' 0 $?
for d in "$root" "$root/proj" "$root/proj/auth" "$root/proj/auth/entries" "$root/proj/auth/entries/x"; do
  h_check "mode of ${d#"$root"}" 700 "$(h_mode "$d")"
done
chmod 777 "$root/proj/auth"; cmux_e2e_mkdir_secure "$root/proj/auth/entries/x"
h_check 'mkdir_secure repairs intermediate mode' 700 "$(h_mode "$root/proj/auth")"

printf x > "$(h_tmp)/t.tmp"; cmux_e2e_install_file "$(h_tmp)/t.tmp" "$root/proj/f"
h_check 'install_file mode' 600 "$(h_mode "$root/proj/f")"

cmux_e2e_secure_path "$root/proj/ok"; h_check 'inside cache root accepted' 0 $?
cmux_e2e_secure_path "$(h_tmp)/outside"; h_check 'outside cache root rejected' 1 $?
cmux_e2e_secure_path "$root/a/../outside"; h_check 'dotdot rejected' 1 $?
cmux_e2e_secure_path "$root/./x"; h_check 'dot rejected' 1 $?
ln -s "$(h_tmp)/elsewhere" "$root/link"
cmux_e2e_secure_path "$root/link/f"; h_check 'symlink component rejected' 1 $?
mkdir -p "$(h_tmp)/real-cache"; rm -rf "$HOME/.cache"; ln -s "$(h_tmp)/real-cache" "$HOME/.cache"
cmux_e2e_secure_path "$root/proj/x"; h_check 'symlinked .cache rejected' 1 $?
rm -f "$HOME/.cache"; mkdir -p "$root"

wt="$PWD"; mkdir -p "$wt/.cmux-e2e-results"
cmux_e2e_secure_artifact "$wt/.cmux-e2e-results/s/summary.md" "$wt"; h_check 'artifact inside worktree ok' 0 $?
cmux_e2e_secure_artifact /etc/passwd "$wt"; h_check 'artifact outside worktree rejected' 1 $?
ln -s "$(h_tmp)/evil" "$wt/.cmux-e2e-results/link"
cmux_e2e_secure_artifact "$wt/.cmux-e2e-results/link/x" "$wt"; h_check 'artifact symlink dir rejected' 1 $?
mkfifo "$wt/.cmux-e2e-results/fifo"
cmux_e2e_secure_artifact "$wt/.cmux-e2e-results/fifo" "$wt"; h_check 'artifact non-regular rejected' 1 $?
rm -rf "$wt/.cmux-e2e-results"

h_assert_no_import
exit "$(h_fail_count)"
