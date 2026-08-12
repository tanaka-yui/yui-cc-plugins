#!/usr/bin/env bash
# 配送経路が send-prompt.sh に一本化されていることの静的検査。
#
# 守っている不変条件:
#   CS1. launch-workspace.sh / monitor-dispatch.sh に cmux send-key の直書きが残らない
#   CS2. 両スクリプトが send-prompt.sh を呼んでいる

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
fail=0

# --- CS1: send-key の直書きが残らない ---
# send-prompt.sh 自身は当然 send-key を呼ぶので対象外。
cs1=1
for f in launch-workspace.sh monitor-dispatch.sh; do
  # grep -n は行頭に行番号を付けるので、コメント行の除外は ':' の後ろを見る
  if grep -n 'send-key' "$SCRIPTS/$f" | grep -qv ':[[:space:]]*#'; then
    echo "  send-key の直書きが残っている: $f"
    grep -n 'send-key' "$SCRIPTS/$f" | head -5
    cs1=0
  fi
done
if [[ $cs1 -eq 1 ]]; then
  echo "PASS CS1: スクリプトに cmux send-key の直書きが残らない"
else
  echo "FAIL CS1: send-key の直書きが残っている"; fail=1
fi

# --- CS2: send-prompt.sh を呼んでいる ---
cs2=1
for f in launch-workspace.sh monitor-dispatch.sh; do
  grep -q 'send-prompt.sh' "$SCRIPTS/$f" || { echo "  send-prompt.sh を呼んでいない: $f"; cs2=0; }
done
if [[ $cs2 -eq 1 ]]; then
  echo "PASS CS2: 両スクリプトが send-prompt.sh を呼んでいる"
else
  echo "FAIL CS2: send-prompt.sh の呼び出しが無い"; fail=1
fi

exit $fail
