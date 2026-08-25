#!/usr/bin/env bash

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBDIR="$SCRIPT_DIR/../skills/cmux-e2e/scripts/lib"
source "$SCRIPT_DIR/lib/harness.sh"
h_setup
trap h_teardown EXIT
source "$LIBDIR/common.sh"; source "$LIBDIR/lock.sh"

root=$(cmux_e2e_cache_root)
MINE="$root/p/locks/mine"
FOREIGN="$root/p/locks/foreign"
cmux_e2e_mkdir_secure "$root/p/locks"
mkdir -m 700 "$FOREIGN"
jq -n '{pid:1, worktree:"/elsewhere", started_at:"2026-01-01T00:00:00Z"}' > "$FOREIGN/owner.json"
chmod 600 "$FOREIGN/owner.json"
foreign_before=$(cat "$FOREIGN/owner.json")

cmux_e2e_lock_acquire "$MINE"; h_check 'acquire own lock' 0 $?
[[ -f "$MINE/owner.json" ]]; h_check 'owner.json written' 0 $?
h_check 'owner.json mode' 600 "$(h_mode "$MINE/owner.json")"
h_check 'lock dir mode' 700 "$(h_mode "$MINE")"
jq -e '.pid and .worktree and .started_at' "$MINE/owner.json" >/dev/null; h_check 'owner fields' 0 $?

err=$(cmux_e2e_lock_acquire "$FOREIGN" 2>&1); rc=$?
h_check 'foreign acquire fails' 1 "$rc"
h_contains 'message has abs path' "$err" "$FOREIGN"
h_contains 'message has rm hint' "$err" 'rm -rf'
h_contains 'message says never reclaims' "$err" 'never reclaims'

cmux_e2e_lock_release_all
[[ -d "$FOREIGN" ]]; h_check 'S1: foreign lock survives release_all' 0 $?
h_check 'S1: foreign owner.json unchanged' "$foreign_before" "$(cat "$FOREIGN/owner.json")"
[[ ! -d "$MINE" ]]; h_check 'own lock is released' 0 $?

cmux_e2e_lock_acquire "$(h_tmp)/outside/lock" >/dev/null 2>&1; h_check 'outside cache root rejected' 1 $?
cmux_e2e_lock_acquire "$MINE" && cmux_e2e_lock_acquire "$root/p/locks/second"; h_check 'acquire two' 0 $?
cmux_e2e_lock_release_all
[[ ! -d "$MINE" && ! -d "$root/p/locks/second" ]]; h_check 'release_all frees all held' 0 $?
cmux_e2e_lock_release_all; h_check 'release_all is idempotent' 0 $?

rm -rf "$FOREIGN"; cmux_e2e_lock_acquire "$FOREIGN"; h_check 'reacquire after manual removal' 0 $?
cmux_e2e_lock_release_all
(CMUX_E2E_JQ="$(h_tmp)/no-such-jq"; cmux_e2e_lock_acquire "$MINE") >/dev/null 2>&1
h_check 'acquire fails without jq' 1 $?
[[ ! -d "$MINE" ]]; h_check 'no lock left behind on owner failure' 0 $?
[[ -z "$(ls -A "$(dirname "$MINE")" 2>/dev/null | grep '^\.owner' || true)" ]]; h_check 'no temp left behind on owner failure' 0 $?

cat > "$(h_tmp)/critical.sh" <<EOS
#!/usr/bin/env bash
set -uo pipefail
source "$LIBDIR/common.sh"; source "$LIBDIR/lock.sh"
cmux_e2e_install_traps
mkdir() {
  command mkdir "\$@"; local rc=\$?
  if [[ "\$1" == "-m" && "\$2" == "700" && "\$3" == "$MINE" ]]; then
    : > "$(h_tmp)/hook-fired"; kill -TERM \$\$
  fi
  return \$rc
}
cmux_e2e_lock_acquire "$MINE"
sleep 5
EOS
bash "$(h_tmp)/critical.sh" >/dev/null 2>&1; h_check 'pending signal exits after registration' 143 $?
[[ -f "$(h_tmp)/hook-fired" ]]; h_check 'critical hook fired' 0 $?
[[ ! -d "$MINE" ]]; h_check 'critical lock released' 0 $?

cat > "$(h_tmp)/child.sh" <<EOS
#!/usr/bin/env bash
set -uo pipefail
source "$LIBDIR/common.sh"; source "$LIBDIR/lock.sh"
cmux_e2e_install_traps
cmux_e2e_lock_acquire "$MINE" || exit 1
sleep 30
EOS
bash "$(h_tmp)/child.sh" & cpid=$!
sleep 1; kill -TERM "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null
h_check 'S2: child exits 143 on TERM' 143 $?
[[ ! -d "$MINE" ]]; h_check 'S2: own lock released on TERM' 0 $?
[[ -d "$FOREIGN" ]] || mkdir -m 700 "$FOREIGN"
h_check 'S2: foreign lock untouched' 0 $?
h_assert_no_import
exit "$(h_fail_count)"
