#!/usr/bin/env bash
# --message-type 廃止と「agmsg は必須」前提の回帰テスト。
#
# 守っている不変条件:
#   MT1. launch-workspace.sh は --message-type を was removed を含む die で拒否する
#   MT2. prewarm-panes.sh は --message-type を was removed を含む die で拒否する
#   MT3. 両スクリプトのソースに MESSAGE_TYPE 変数が残らない
#   MT4. SKILL.md に AGMSG_INSTALLED による true/false 二系統分岐が残らない
#        (agmsg 不在・watcher 不在は fail-fast であり、degraded モードは存在しない)
#   MT5. SKILL.md の Step 1g が agmsg の存在と自セッションの watcher 生存を
#        verify-agmsg-ready.sh --self で確認し、どちらも満たさなければ exit 1 する
#
# MT4/MT5 が対になっているのは、片方だけでは空虚に PASS するため。MT4 だけなら
# 「分岐も guard も無い」(誰も readiness を確認しない) 状態を通してしまい、MT5 だけなら
# 「guard はあるが失敗時に degraded モードへ降格する」二系統を通してしまう。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/scripts"
SKILL="$SCRIPT_DIR/../skills/cmux-team-dispatch-task/SKILL.md"
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

# --- MT4: AGMSG_INSTALLED 二系統分岐が SKILL.md に残らない ---
[[ -r "$SKILL" ]] || { echo "FAIL MT4/MT5: SKILL.md が読めない: $SKILL"; exit 1; }
if grep -q 'AGMSG_INSTALLED' "$SKILL"; then
  echo "FAIL MT4: AGMSG_INSTALLED の二系統分岐が残っている"
  grep -n 'AGMSG_INSTALLED' "$SKILL" | head -5
  fail=1
else
  echo "PASS MT4: SKILL.md に AGMSG_INSTALLED は残らない (agmsg は必須前提)"
fi

# --- MT5: Step 1g が agmsg 必須の fail-fast guard になっている ---
mt5=1
grep -Fq 'bash <SKILL_DIR>/scripts/verify-agmsg-ready.sh --self' "$SKILL" \
  || { echo "  Step 1g に verify-agmsg-ready.sh --self の呼び出しが無い"; mt5=0; }
grep -Fq '[[ -f ~/.agents/skills/agmsg/scripts/send.sh ]] ||' "$SKILL" \
  || { echo "  agmsg 未インストールを検出する guard が無い"; mt5=0; }
# guard の両分岐が exit 1 で止まること (degraded モードへ降格しないこと)
if [[ $(grep -c 'exit 1; }' "$SKILL") -lt 2 ]]; then
  echo "  agmsg 不在 / watcher 不在のどちらかが exit 1 で止まっていない"; mt5=0
fi
if [[ $mt5 -eq 1 ]]; then
  echo "PASS MT5: Step 1g は agmsg 不在・watcher 不在をどちらも fail-fast で止める"
else
  echo "FAIL MT5: agmsg 必須の fail-fast guard になっていない"; fail=1
fi

exit $fail
