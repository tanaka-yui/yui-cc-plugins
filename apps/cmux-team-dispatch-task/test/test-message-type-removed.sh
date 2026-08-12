#!/usr/bin/env bash
# --message-type 廃止の回帰テスト。
#
# 守っている不変条件:
#   MT1. launch-workspace.sh は --message-type を was removed を含む die で拒否する
#   MT2. prewarm-panes.sh は --message-type を was removed を含む die で拒否する
#   MT3. 両スクリプトのソースに MESSAGE_TYPE 変数が残らない

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
fail=0

check_rejects() {
  local id="$1" script="$2"
  local out rc
  out=$(bash "$SCRIPTS/$script" --message-type agmsg 2>&1); rc=$?
  if [[ $rc -ne 0 ]] && grep -q 'was removed' <<<"$out"; then
    echo "PASS $id: $script は --message-type を was removed で拒否する"
  else
    echo "FAIL $id: rc=$rc out=[$out]"; fail=1
  fi
}

check_rejects MT1 launch-workspace.sh
check_rejects MT2 prewarm-panes.sh

# --- MT3: MESSAGE_TYPE 変数が残らない ---
mt3=1
for f in launch-workspace.sh prewarm-panes.sh; do
  if grep -q 'MESSAGE_TYPE' "$SCRIPTS/$f"; then
    echo "  MESSAGE_TYPE が残っている: $f"
    grep -n 'MESSAGE_TYPE' "$SCRIPTS/$f" | head -5
    mt3=0
  fi
done
if [[ $mt3 -eq 1 ]]; then
  echo "PASS MT3: 両スクリプトに MESSAGE_TYPE 変数が残らない"
else
  echo "FAIL MT3: MESSAGE_TYPE が残っている"; fail=1
fi

exit $fail
