#!/usr/bin/env bash
# ensure-agmsg-ready.sh と agmsg-path.sh の回帰テスト。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SD="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"

fail=0
bad() { echo "FAIL: $1" >&2; fail=1; }

# --- AR17: エンコードのゴールデンベクタ ---
# shellcheck disable=SC1091
source "$SD/agmsg-path.sh"

check_enc() {  # <team> <agent> <expected basename>
  local got
  got=$(agmsg_ready_path /run "$1" "$2")
  [[ "$got" == "/run/$3" ]] || bad "AR17 enc('$1','$2') = $got (want /run/$3)"
}
check_enc 'dispatch-my repo'  parent   'ready.dispatch-my%20repo__parent'
check_enc 'dispatch-a%b'      parent   'ready.dispatch-a%25b__parent'
check_enc 'dispatch-日本'      parent   'ready.dispatch-%E6%97%A5%E6%9C%AC__parent'
check_enc 'dispatch-ok_1.2-3' x-review 'ready.dispatch-ok_1.2-3__x-review'

[[ $fail -eq 0 ]] && echo '--- all tests passed ---' || echo '--- failures ---'
exit "$fail"
